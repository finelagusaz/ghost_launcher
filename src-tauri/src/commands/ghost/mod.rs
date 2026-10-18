// mod.rs
mod fingerprint;
mod path_utils;
mod scan;
pub(crate) mod store;
mod types;

// ベンチ計測用の内部関数・型の最小露出。feature 無効時は一切影響しない。
#[cfg(feature = "bench")]
pub(crate) use fingerprint::{check_parent_mtimes_match, collect_parent_mtimes};
#[cfg(feature = "bench")]
pub(crate) use scan::{
    ScanEntry, fingerprint_only_internal, scan_entries_with_fingerprint,
    scan_ghosts_with_fingerprint_internal,
};
#[cfg(feature = "bench")]
pub(crate) use types::Ghost;

pub use types::ScanStoreResult;

/// request_key が空なら Err を返す。JS 単一権威の信頼境界での最小防御。
/// 空キーで書き込むと全ゴーストが request_key='' パーティションに同居する事故を防ぐ。
fn ensure_request_key(request_key: &str) -> Result<(), String> {
    if request_key.is_empty() {
        return Err("request_key が空です".to_string());
    }
    Ok(())
}

/// ゴーストをスキャンし SQLite へ直接書き込むコマンド。実体は DB アクターの Scan ジョブ。
/// walk＋parse＋DB 適用の全体がアクター上で直列化される（設計書 §3。2 scan が同じ prev から
/// 差分計算する lost update を構造的に防ぐ）。IPC 契約（引数名・戻り値）は不変。
#[tauri::command]
pub async fn scan_and_store(
    ssp_path: String,
    additional_folders: Vec<String>,
    request_key: String,
    cached_fingerprint: Option<String>,
    actor: tauri::State<'_, crate::actor::ActorHandle>,
) -> Result<ScanStoreResult, String> {
    actor
        .request(|reply| crate::actor::Job::Scan {
            ssp_path,
            additional_folders,
            request_key,
            cached_fingerprint,
            reply,
        })
        .await
}

/// 古い request_key 世代のキャッシュを削除するコマンド（設計書 §5.1 の契約）。
/// 戻り値は削除した request_key 数（JS はログにのみ使用）。
#[tauri::command]
pub async fn cleanup_ghost_caches(
    current_request_key: String,
    actor: tauri::State<'_, crate::actor::ActorHandle>,
) -> Result<u32, String> {
    actor
        .request(|reply| crate::actor::Job::CleanupCaches {
            current_request_key,
            reply,
        })
        .await
}

/// `scan_and_store` の同期本体。DB アクタースレッド上で `run_guarded` 経由に呼ばれる
/// （接続はアクターが所有し、常にスキーマ確定済みであることが呼び出し側の不変条件）。
///
/// 2 層フィンガープリント:
/// - Layer 1: 親ディレクトリ mtime チェック（< 1ms）。ゴーストフォルダの追加・削除を検出
/// - Layer 2: 従来のフル fingerprint。全エントリの mtime + descript.txt 有無を走査
pub(crate) fn scan_and_store_blocking(
    conn: &rusqlite::Connection,
    user_conn: &rusqlite::Connection,
    ssp_path: String,
    additional_folders: Vec<String>,
    request_key: String,
    cached_fingerprint: Option<String>,
) -> Result<ScanStoreResult, String> {
    ensure_request_key(&request_key)?;

    // 親ディレクトリ mtime を 1 回だけ収集（Layer 1 / Layer 2 hit / cache miss で共用）
    let current_mtimes = fingerprint::collect_parent_mtimes(&ssp_path, &additional_folders);

    // Layer 1: 親ディレクトリ mtime 高速チェック（< 1ms）
    // NTFS では親の mtime は直下のエントリ追加・削除でのみ変化する。
    // 既存ゴースト内の descript.txt 編集は検出できない（「再読込」で対応）。
    // hit 経路は backfill_aggregates を呼ばない（#156）。集計列の平常時更新は
    // record_launch の即時 bump が担い、healing（リビルド後の復元・bump 失敗の修復）は
    // cache miss 経路の backfill に遅延する（集計列は導出キャッシュで、ズレの実害は並び順のみ）。
    if cached_fingerprint.is_some()
        && fingerprint::check_parent_mtimes_match(conn, &request_key, &current_mtimes)
    {
        return Ok(ScanStoreResult {
            cache_hit: true,
            total: 0,
            fingerprint: cached_fingerprint.unwrap_or_default(),
            request_key,
        });
    }

    // Layer 2: 走査（parse なし）で ScanEntry 群 + fingerprint を得る。
    // fingerprint は従来と同一（全エントリの mtime + descript.txt 有無）。parse は変更子だけ後段で行う。
    let (entries, fingerprint) =
        scan::scan_entries_with_fingerprint(&ssp_path, &additional_folders)?;

    // DB 書込前・全 present エントリ上で identity 一意性を検証（NFKC 衝突を loud に弾く。
    // delta の parse-skip で失われる DB 側 UNIQUE の loud 性の単一代替）。
    scan::check_identity_uniqueness(&entries)?;

    let cache_hit = cached_fingerprint.as_deref() == Some(fingerprint.as_str());

    if cache_hit {
        // Layer 2 hit: 親 mtime は変わったがゴースト構成は同じ
        // parent_mtimes を更新して次回 Layer 1 で hit するようにする
        // （hit 経路ゆえ backfill も呼ばない。Layer 1 のコメント参照・#156）
        let _ = conn.execute(
            "UPDATE ghost_fingerprints SET parent_mtimes = ?1 WHERE request_key = ?2",
            rusqlite::params![current_mtimes, request_key],
        );
        return Ok(ScanStoreResult {
            cache_hit: true,
            total: 0,
            fingerprint,
            request_key,
        });
    }

    // Cache miss → delta 差分書き込み（前回 scan_entries と差分を取り、変更子だけ parse）
    let total = apply_scan_delta(
        conn,
        &request_key,
        &entries,
        &store::FingerprintRow {
            fingerprint: &fingerprint,
            parent_mtimes: &current_mtimes,
        },
    )?;

    // healing: リビルド後の集計復元と record_launch bump 失敗の修復（cache miss 経路のみ・#156）
    let _ = crate::commands::launch_history::backfill_aggregates(conn, user_conn);

    Ok(ScanStoreResult {
        cache_hit: false,
        total,
        fingerprint,
        request_key,
    })
}

/// Layer 2 ミス時の delta 適用: 前回 scan_entries と差分を取り、変更子だけ parse して
/// `store_ghosts_delta` で書き込む。前回 scan_entries が空（初回/移行）なら全子が「新規」となり
/// 全 parse へ自然に縮退する（ON CONFLICT UPDATE が既存 ghosts と突合するため UNIQUE 衝突しない）。
/// 戻り値 = 適用後の ghosts 件数。
///
/// `pub(crate)` は bench（granular rescan 計測）が本番経路を end-to-end で駆動するため。
pub(crate) fn apply_scan_delta(
    conn: &rusqlite::Connection,
    request_key: &str,
    entries: &[scan::ScanEntry],
    fingerprint_row: &store::FingerprintRow,
) -> Result<usize, String> {
    use rayon::prelude::*;
    use std::collections::HashSet;

    // 前回状態: scan_key -> (token, identity_key)
    let prev = store::read_scan_entries(conn, request_key)?;

    // 差分: 変更子（token 変化 or 新規）を分類。不変子は触らない。
    let mut changed_present: Vec<&scan::ScanEntry> = Vec::new();
    let mut delete_identities: Vec<String> = Vec::new();
    let mut scan_upserts: Vec<store::ScanEntryRow> = Vec::new();

    for entry in entries {
        let changed = match prev.get(&entry.scan_key) {
            Some((prev_token, _)) => prev_token != &entry.token,
            None => true, // 新規 scan_key
        };
        if !changed {
            continue; // 不変子: parse も DB 書込もしない
        }
        scan_upserts.push(store::ScanEntryRow {
            scan_key: &entry.scan_key,
            token: &entry.token,
            identity_key: &entry.identity_key,
        });
        if entry.is_present {
            changed_present.push(entry); // parse 対象
        } else {
            // descript 無し（新規 no-descript or descript 消滅）→ ghost を除去（no-op 含む）
            delete_identities.push(entry.identity_key.clone());
        }
    }

    // 削除子（前回にあり今回の walk に無い scan_key）→ その identity を DELETE・scan_entry を削除
    let current_keys: HashSet<&str> = entries.iter().map(|e| e.scan_key.as_str()).collect();
    let mut scan_deletes: Vec<String> = Vec::new();
    for (scan_key, (_, identity)) in &prev {
        if !current_keys.contains(scan_key.as_str()) {
            delete_identities.push(identity.clone());
            scan_deletes.push(scan_key.clone());
        }
    }

    // 初回/移行（前回 scan_entries 空）: scan-diff では取り残しを検知できないため、既存 ghosts のうち
    // 今回の present に無い identity を DELETE 対象に加える（set-difference）。旧コードで書かれた行や
    // cleanupOldGhostCaches とのズレを自己修復する。定常 delta（prev 非空・毎回 ghosts と scan_entries を
    // 原子的に書くため常に完全）ではこの O(既存件数) の読みを行わない。新規インストール（既存も空）は
    // 取り残しゼロで通常の全 INSERT に縮退する。
    if prev.is_empty() {
        let present: HashSet<&str> = entries
            .iter()
            .filter(|e| e.is_present)
            .map(|e| e.identity_key.as_str())
            .collect();
        for identity in store::read_ghost_identities(conn, request_key)? {
            if !present.contains(identity.as_str()) {
                delete_identities.push(identity);
            }
        }
    }

    // 変更子（present）を並列 parse: 成功→upsert、失敗（破損/欠落）→ identity を DELETE 候補へ
    let parsed: Vec<Option<types::Ghost>> = changed_present
        .par_iter()
        .map(|&entry| scan::parse_entry(entry))
        .collect();
    let mut upserts: Vec<types::Ghost> = Vec::new();
    let mut parse_failed: Vec<String> = Vec::new();
    for (entry, ghost) in changed_present.iter().zip(parsed) {
        match ghost {
            Some(g) => upserts.push(g),
            None => parse_failed.push(entry.identity_key.clone()),
        }
    }
    delete_identities.extend(parse_failed.iter().cloned());

    // サイレント消失の防止（設計書 §4.2）: DELETE は畳み込み identity_key で行うため、非 present の
    // 兄弟ディレクトリが NFKC 畳み込みで「生き残る present ゴースト」と同一 identity に落ちると、
    // その present ゴーストまで巻き込んで消しかねない（present 同士は check_identity_uniqueness が
    // 書込前に loud に弾くが、非 present はガードを通り抜ける）。生き残る present の identity
    // （present 全体から parse 失敗分を除く。present 同士は identity 一意がガードで保証済み）を
    // DELETE 集合から保護し、旧来の「非ゴーストの兄弟は無視」挙動へ収束させる。
    let protected: HashSet<&str> = {
        let failed: HashSet<&str> = parse_failed.iter().map(|s| s.as_str()).collect();
        entries
            .iter()
            .filter(|e| e.is_present)
            .map(|e| e.identity_key.as_str())
            .filter(|id| !failed.contains(id))
            .collect()
    };
    delete_identities.retain(|id| !protected.contains(id.as_str()));

    store::store_ghosts_delta(
        conn,
        request_key,
        &store::GhostDelta {
            upserts: &upserts,
            deletes: &delete_identities,
            scan_upserts: &scan_upserts,
            scan_deletes: &scan_deletes,
        },
        fingerprint_row,
    )
}

#[cfg(test)]
mod tests {
    use super::store::FingerprintRow;
    use crate::testutil::{TempDirGuard, create_ghost_dir_with_descript};
    use std::fs;
    use std::path::Path;

    /// マイグレーション適用済みのインメモリ ghosts DB（apply_scan_delta の直接テスト用）。
    fn in_memory_ghost_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::testutil::apply_cache_schema(&conn);
        conn
    }

    #[test]
    fn ensure_request_key_は空文字を拒否し非空を許可する() {
        assert!(super::ensure_request_key("").is_err());
        assert!(super::ensure_request_key("c:/ssp::").is_ok());
    }

    /// 移行取り残しの削除: ghosts に A,B,C・scan_entries 空の状態で C がディスクから消えた初回スキャン。
    /// scan-diff では検知できない取り残し C を set-difference（read_ghost_identities × present 差分）で削除する。
    /// これは delta の parse-skip 導入で開いた correctness の穴（永久幽霊ゴースト）を塞ぐ。
    #[test]
    fn apply_scan_delta_が移行時の取り残しゴーストを削除する() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_delta_straggler_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost).map_err(|e| format!("ssp ghost dir: {e}"))?;
        create_ghost_dir_with_descript(&ssp_ghost, "a", "name,A\ncharset,UTF-8\n")?;
        create_ghost_dir_with_descript(&ssp_ghost, "b", "name,B\ncharset,UTF-8\n")?;
        create_ghost_dir_with_descript(&ssp_ghost, "c", "name,C\ncharset,UTF-8\n")?;

        let conn = in_memory_ghost_db();
        let ssp_path = ssp_root.to_string_lossy().to_string();

        // 初回シード: A,B,C を書き込む（scan_entries も seed される）
        let (entries_all, fp1) = super::scan::scan_entries_with_fingerprint(&ssp_path, &[])?;
        let total1 = super::apply_scan_delta(
            &conn,
            "rk1",
            &entries_all,
            &FingerprintRow {
                fingerprint: &fp1,
                parent_mtimes: "mt-1",
            },
        )?;
        assert_eq!(total1, 3);

        // 移行を模す: scan_entries を空にする（旧 DB は ghosts のみで scan_entries を持たない）
        conn.execute(
            "DELETE FROM ghost_scan_entries WHERE request_key = ?1",
            ["rk1"],
        )
        .unwrap();

        // C をディスクから削除して再スキャン → walk は A,B のみを返す
        fs::remove_dir_all(ssp_ghost.join("c")).map_err(|e| format!("remove c: {e}"))?;
        let (entries_bc, fp2) = super::scan::scan_entries_with_fingerprint(&ssp_path, &[])?;
        let total2 = super::apply_scan_delta(
            &conn,
            "rk1",
            &entries_bc,
            &FingerprintRow {
                fingerprint: &fp2,
                parent_mtimes: "mt-2",
            },
        )?;

        assert_eq!(
            total2, 2,
            "取り残し C が削除されていない（永久幽霊ゴースト）"
        );
        let mut names: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT name FROM ghosts WHERE request_key = ?1")
                .unwrap();
            let rows = stmt.query_map(["rk1"], |r| r.get::<_, String>(0)).unwrap();
            rows.filter_map(|r| r.ok()).collect()
        };
        names.sort();
        assert_eq!(names, vec!["A".to_string(), "B".to_string()]);
        Ok(())
    }

    /// サイレント消失回帰: present-不変の "Ａ"（identity ssp\x1fa）に、後から現れた非 present の "a"
    /// （descript 無し・NFKC 畳み込みで同一 identity）が同居しても、"a" の DELETE が生存 present "Ａ" を
    /// 巻き込まないこと。生の scan_key は別だが identity は衝突し、check_identity_uniqueness は present しか
    /// 見ないため非 present の "a" はガードを通り抜ける。DELETE の identity 保護フィルタで防ぐ（設計書 §4.2）。
    #[test]
    fn apply_scan_delta_が非present兄弟のnfkc畳み込みで生存ゴーストを消さない() -> Result<(), String>
    {
        let workspace = TempDirGuard::new("ghost_launcher_delta_fold_delete_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost).map_err(|e| format!("ssp ghost dir: {e}"))?;
        create_ghost_dir_with_descript(&ssp_ghost, "Ａ", "name,Fullwidth\ncharset,UTF-8\n")?;

        let conn = in_memory_ghost_db();
        let ssp_path = ssp_root.to_string_lossy().to_string();

        // 初回シード: Ａ を書き込む
        let (e1, fp1) = super::scan::scan_entries_with_fingerprint(&ssp_path, &[])?;
        super::apply_scan_delta(
            &conn,
            "rk1",
            &e1,
            &FingerprintRow {
                fingerprint: &fp1,
                parent_mtimes: "mt-1",
            },
        )?;

        // 非 present の "a"（descript 無しディレクトリ）を追加 → 再スキャン
        fs::create_dir_all(ssp_ghost.join("a")).map_err(|e| format!("create a: {e}"))?;
        let (e2, fp2) = super::scan::scan_entries_with_fingerprint(&ssp_path, &[])?;
        let total = super::apply_scan_delta(
            &conn,
            "rk1",
            &e2,
            &FingerprintRow {
                fingerprint: &fp2,
                parent_mtimes: "mt-2",
            },
        )?;

        assert_eq!(
            total, 1,
            "生存 present ゴースト Ａ が NFKC 畳み込みの DELETE で消えた（サイレント消失の退行）"
        );
        let name: String = conn
            .query_row(
                "SELECT name FROM ghosts WHERE request_key = ?1",
                ["rk1"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name, "Fullwidth");
        Ok(())
    }

    /// user-data.db 接続（起動履歴スキーマ適用済み）を作る（backfill 経路テスト用）。
    fn in_memory_user_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::commands::launch_history::ensure_schema(&conn).unwrap();
        conn
    }

    /// backfill 経路テストの共通 seed: ゴースト 1 体（alpha）を cache miss で書き込み、
    /// その後に user-data へ起動履歴を 1 件挿入した状態を作る。
    /// 以降に backfill_aggregates が走れば集計列（launch_count/last_launched）が
    /// 0/NULL でなくなるため、「集計列が不変」= GROUP BY 非発行の観測になる。
    /// 戻り値は (seed 時の fingerprint, alpha の identity_key)。
    fn seed_ghost_and_pending_launch(
        conn: &rusqlite::Connection,
        user_conn: &rusqlite::Connection,
        ssp_root: &Path,
    ) -> Result<(String, String), String> {
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost).map_err(|e| format!("ssp ghost dir: {e}"))?;
        create_ghost_dir_with_descript(&ssp_ghost, "alpha", "name,Alpha\ncharset,UTF-8\n")?;
        let seeded = super::scan_and_store_blocking(
            conn,
            user_conn,
            ssp_root.to_string_lossy().to_string(),
            vec![],
            "rk1".to_string(),
            None,
        )?;
        assert!(!seeded.cache_hit, "seed は cache miss であるべき");

        let identity = super::store::ghost_identity_key("ssp", "alpha");
        user_conn
            .execute(
                "INSERT INTO ghost_launches (ghost_identity_key, launched_at) VALUES (?1, '2026-01-01 00:00:00')",
                rusqlite::params![identity],
            )
            .unwrap();
        Ok((seeded.fingerprint, identity))
    }

    fn read_aggregates(conn: &rusqlite::Connection, identity: &str) -> (i64, Option<String>) {
        conn.query_row(
            "SELECT launch_count, last_launched FROM ghosts WHERE ghost_identity_key = ?1",
            [identity],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    /// Phase 3（#156）: Layer 1 hit（親 mtime 不変）の高速パスで backfill_aggregates が
    /// 発行されないこと。走れば seed 後に挿入した履歴が集計列へ再導出され 0/NULL でなくなる。
    #[test]
    fn scan_and_store_blockingのlayer1_hit経路はbackfillを発行しない() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_backfill_layer1_test");
        let ssp_root = workspace.path().join("ssp");
        let conn = in_memory_ghost_db();
        let user_conn = in_memory_user_db();
        let (fingerprint, identity) = seed_ghost_and_pending_launch(&conn, &user_conn, &ssp_root)?;

        // 親 mtime 不変 + cached_fingerprint あり → Layer 1 hit
        let result = super::scan_and_store_blocking(
            &conn,
            &user_conn,
            ssp_root.to_string_lossy().to_string(),
            vec![],
            "rk1".to_string(),
            Some(fingerprint),
        )?;
        assert!(
            result.cache_hit,
            "Layer 1 hit にならなかった（テスト前提の崩れ）"
        );

        let (count, last) = read_aggregates(&conn, &identity);
        assert_eq!(
            count, 0,
            "Layer 1 hit 経路で backfill が発行された（#156 の退行）"
        );
        assert_eq!(last, None);
        Ok(())
    }

    /// Phase 3（#156）: Layer 2 hit（fingerprint 一致・parent_mtimes 欠損＝旧世代 DB 移行時）
    /// でも backfill_aggregates が発行されないこと。
    #[test]
    fn scan_and_store_blockingのlayer2_hit経路はbackfillを発行しない() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_backfill_layer2_test");
        let ssp_root = workspace.path().join("ssp");
        let conn = in_memory_ghost_db();
        let user_conn = in_memory_user_db();
        let (fingerprint, identity) = seed_ghost_and_pending_launch(&conn, &user_conn, &ssp_root)?;

        // parent_mtimes を欠損させ Layer 1 を外す → Layer 2 の fingerprint 等値判定で hit
        conn.execute(
            "UPDATE ghost_fingerprints SET parent_mtimes = '' WHERE request_key = 'rk1'",
            [],
        )
        .unwrap();
        let result = super::scan_and_store_blocking(
            &conn,
            &user_conn,
            ssp_root.to_string_lossy().to_string(),
            vec![],
            "rk1".to_string(),
            Some(fingerprint),
        )?;
        assert!(
            result.cache_hit,
            "Layer 2 hit にならなかった（テスト前提の崩れ）"
        );

        let (count, last) = read_aggregates(&conn, &identity);
        assert_eq!(
            count, 0,
            "Layer 2 hit 経路で backfill が発行された（#156 の退行）"
        );
        assert_eq!(last, None);
        Ok(())
    }

    /// Phase 3（#156）の対称ガード: cache miss（実書込）経路では backfill_aggregates が
    /// 引き続き発行されること（リビルド後の集計復元と bump 失敗修復の healing 責務）。
    #[test]
    fn scan_and_store_blockingのcache_miss経路はbackfillを発行する() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_backfill_miss_test");
        let ssp_root = workspace.path().join("ssp");
        let conn = in_memory_ghost_db();
        let user_conn = in_memory_user_db();
        let (fingerprint, identity) = seed_ghost_and_pending_launch(&conn, &user_conn, &ssp_root)?;

        // ゴースト追加で親 mtime も fingerprint も変える → cache miss
        create_ghost_dir_with_descript(
            &ssp_root.join("ghost"),
            "bravo",
            "name,Bravo\ncharset,UTF-8\n",
        )?;
        let result = super::scan_and_store_blocking(
            &conn,
            &user_conn,
            ssp_root.to_string_lossy().to_string(),
            vec![],
            "rk1".to_string(),
            Some(fingerprint),
        )?;
        assert!(
            !result.cache_hit,
            "cache miss にならなかった（テスト前提の崩れ）"
        );

        let (count, last) = read_aggregates(&conn, &identity);
        assert_eq!(
            count, 1,
            "cache miss 経路の backfill（healing 責務）が失われた"
        );
        assert_eq!(last.as_deref(), Some("2026-01-01 00:00:00"));
        Ok(())
    }

    /// parse-skip（本 issue の性能の要）を CI で決定論的に固定する。descript の内容だけ書き換えて
    /// mtime を元に戻すと token（親 dir mtime + descript 状態/mtime）が不変になり、delta は当該子を
    /// 不変とみなして再 parse しない → DB は旧内容のまま。もし不変子まで再 parse するリグレッションが
    /// 入れば新内容が反映されて赤くなる。結果の正しさテスト群は全 parse でも緑になるため、parse-skip
    /// の発生を縛る唯一のユニットテスト（bench は CI 非対象）。
    #[test]
    fn apply_scan_delta_が不変子を再parseしない() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_delta_skip_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost).map_err(|e| format!("ssp ghost dir: {e}"))?;
        create_ghost_dir_with_descript(&ssp_ghost, "alpha", "name,Original\ncharset,UTF-8\n")?;

        let descript = ssp_ghost
            .join("alpha")
            .join("ghost")
            .join("master")
            .join("descript.txt");
        let orig_mtime = fs::metadata(&descript)
            .map_err(|e| format!("meta: {e}"))?
            .modified()
            .map_err(|e| format!("mtime: {e}"))?;

        let conn = in_memory_ghost_db();
        let ssp_path = ssp_root.to_string_lossy().to_string();

        // 初回シード → DB name="Original"
        let (e1, fp1) = super::scan::scan_entries_with_fingerprint(&ssp_path, &[])?;
        super::apply_scan_delta(
            &conn,
            "rk1",
            &e1,
            &FingerprintRow {
                fingerprint: &fp1,
                parent_mtimes: "mt-1",
            },
        )?;

        // 内容だけ書き換え、descript の mtime を元に戻して token を不変に保つ
        // （親 dir mtime は深い書込では変化しない・descript mtime のみ復元すれば token 不変）
        fs::write(&descript, "name,Modified\ncharset,UTF-8\n")
            .map_err(|e| format!("rewrite: {e}"))?;
        let f = fs::OpenOptions::new()
            .write(true)
            .open(&descript)
            .map_err(|e| format!("reopen: {e}"))?;
        f.set_modified(orig_mtime)
            .map_err(|e| format!("set_modified: {e}"))?;
        drop(f);

        // 再スキャン → token 不変 → delta は alpha を再 parse しない
        let (e2, fp2) = super::scan::scan_entries_with_fingerprint(&ssp_path, &[])?;
        super::apply_scan_delta(
            &conn,
            "rk1",
            &e2,
            &FingerprintRow {
                fingerprint: &fp2,
                parent_mtimes: "mt-2",
            },
        )?;

        let name: String = conn
            .query_row(
                "SELECT name FROM ghosts WHERE request_key = ?1",
                ["rk1"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            name, "Original",
            "不変子（token 一致）が再 parse された（parse-skip のリグレッション）"
        );
        Ok(())
    }
}
