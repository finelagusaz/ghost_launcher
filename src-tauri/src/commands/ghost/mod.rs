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
    fingerprint_only_internal, scan_entries_with_fingerprint,
    scan_ghosts_with_fingerprint_internal, ScanEntry,
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

/// 起動履歴の集計列を user-data.db から ghosts へ再導出する（ベストエフォート）。
/// user-data.db を開けない場合は何もしない（スキャン結果を阻害しない）。
/// `<R>` はテストで `MockRuntime` を渡せるようにするためのランタイム総称化（本番は `Wry` に推論）。
fn backfill_launch_aggregates<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    ghosts_conn: &rusqlite::Connection,
) {
    if let Ok(user_conn) = crate::commands::launch_history::open_user_data_db(app) {
        let _ = crate::commands::launch_history::backfill_aggregates(ghosts_conn, &user_conn);
    }
}

/// ゴーストをスキャンし、結果を rusqlite で直接 SQLite に書き込むコマンド。
/// IPC で Ghost 配列を転送しないため、10 万体規模でも高速。
///
/// 2 層フィンガープリント:
/// - Layer 1: 親ディレクトリ mtime チェック（< 1ms）。ゴーストフォルダの追加・削除を検出
/// - Layer 2: 従来のフル fingerprint。全エントリの mtime + descript.txt 有無を走査
/// `<R>` はテストで `MockRuntime` を渡せるようにするためのランタイム総称化（本番は `Wry` に推論）。
/// IPC 契約（引数名・戻り値）は不変で、総称パラメータは境界を越えて見えない。
#[tauri::command]
pub async fn scan_and_store<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    ssp_path: String,
    additional_folders: Vec<String>,
    request_key: String,
    cached_fingerprint: Option<String>,
    coordinator: tauri::State<'_, crate::scan_coordinator::ScanCoordinator>,
) -> Result<ScanStoreResult, String> {
    // scan/reset/record_launch を直列化（lost update 防止）。
    coordinator
        .run_serialized("スキャンタスク", move || {
            scan_and_store_blocking(&app, ssp_path, additional_folders, request_key, cached_fingerprint)
        })
        .await
}

/// 現行 `scan_and_store` の同期本体（挙動不変）。`spawn_blocking` の別スレッドで実行される。
fn scan_and_store_blocking<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    ssp_path: String,
    additional_folders: Vec<String>,
    request_key: String,
    cached_fingerprint: Option<String>,
) -> Result<ScanStoreResult, String> {
    ensure_request_key(&request_key)?;

    // 親ディレクトリ mtime を 1 回だけ収集（Layer 1 / Layer 2 hit / cache miss で共用）
    let current_mtimes = fingerprint::collect_parent_mtimes(&ssp_path, &additional_folders);

    // DB パスを 1 回だけ解決（reset_ghost_db・sanitize_ghost_db と同一の単一権威を経由）
    let db_path = crate::db_path::ghost_db_path(app)?;

    // Layer 1: 親ディレクトリ mtime 高速チェック（< 1ms）
    // NTFS では親の mtime は直下のエントリ追加・削除でのみ変化する。
    // 既存ゴースト内の descript.txt 編集は検出できない（「再読込」で対応）。
    if cached_fingerprint.is_some() && db_path.exists() {
        if let Ok(conn) = rusqlite::Connection::open(&db_path) {
            let _ = store::configure_connection(&conn);
            if fingerprint::check_parent_mtimes_match(&conn, &request_key, &current_mtimes) {
                backfill_launch_aggregates(app, &conn);
                return Ok(ScanStoreResult {
                    cache_hit: true,
                    total: 0,
                    fingerprint: cached_fingerprint.unwrap_or_default(),
                    request_key,
                });
            }
        }
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
        if let Ok(conn) = rusqlite::Connection::open(&db_path) {
            let _ = store::configure_connection(&conn);
            let _ = conn.execute(
                "UPDATE ghost_fingerprints SET parent_mtimes = ?1 WHERE request_key = ?2",
                rusqlite::params![current_mtimes, request_key],
            );
            backfill_launch_aggregates(app, &conn);
        }
        return Ok(ScanStoreResult {
            cache_hit: true,
            total: 0,
            fingerprint,
            request_key,
        });
    }

    // Cache miss → delta 差分書き込み（前回 scan_entries と差分を取り、変更子だけ parse）
    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| format!("DB オープンエラー: {e}"))?;
    store::configure_connection(&conn)?;

    let total = apply_scan_delta(&conn, &request_key, &entries, &fingerprint, &current_mtimes)?;

    backfill_launch_aggregates(app, &conn);

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
    fingerprint: &str,
    parent_mtimes: &str,
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
        &upserts,
        &delete_identities,
        &scan_upserts,
        &scan_deletes,
        fingerprint,
        parent_mtimes,
    )
}

#[cfg(test)]
mod tests {
    use super::fingerprint::build_fingerprint;
    use super::path_utils::unique_sorted_additional_folders;
    use super::scan::scan_ghosts_with_fingerprint_internal;
    use crate::testutil::TempDirGuard;
    use std::fs;
    use std::path::PathBuf;

    fn create_ghost_dir(root: &PathBuf, name: &str) -> Result<(), String> {
        create_ghost_dir_with_descript(root, name, "name,Test Ghost\ncharset,UTF-8\n")
    }

    fn create_ghost_dir_with_descript(
        root: &PathBuf,
        name: &str,
        descript: &str,
    ) -> Result<(), String> {
        let base = root.join(name).join("ghost").join("master");
        fs::create_dir_all(&base)
            .map_err(|error| format!("failed to create ghost dir {}: {}", base.display(), error))?;
        fs::write(base.join("descript.txt"), descript)
            .map_err(|error| format!("failed to write descript: {}", error))
    }

    /// マイグレーション適用済みのインメモリ ghosts DB（apply_scan_delta の直接テスト用）。
    fn in_memory_ghost_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let mut sorted = crate::migrations();
        sorted.sort_by_key(|m| m.version);
        for m in &sorted {
            conn.execute_batch(m.sql).unwrap();
        }
        conn
    }

    #[test]
    fn ensure_request_key_は空文字を拒否し非空を許可する() {
        assert!(super::ensure_request_key("").is_err());
        assert!(super::ensure_request_key("c:/ssp::").is_ok());
    }

    #[test]
    fn unique_sorted_additional_folders_dedupes_by_normalized_path() {
        let folders = vec![
            "C:\\Ghosts\\Extra".to_string(),
            "c:/ghosts/extra".to_string(),
            "C:/Ghosts/Another".to_string(),
        ];

        let actual = unique_sorted_additional_folders(&folders);

        assert_eq!(actual.len(), 2);
        assert_eq!(actual[0].2, "c:/ghosts/another");
        assert_eq!(actual[1].2, "c:/ghosts/extra");
    }

    #[test]
    fn build_fingerprint_is_order_independent_for_additional_folders() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_fingerprint_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost)
            .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
        create_ghost_dir(&ssp_ghost, "base_ghost")?;

        let additional_a = workspace.path().join("additional_a");
        let additional_b = workspace.path().join("additional_b");
        fs::create_dir_all(&additional_a)
            .map_err(|error| format!("failed to create additional_a: {}", error))?;
        fs::create_dir_all(&additional_b)
            .map_err(|error| format!("failed to create additional_b: {}", error))?;
        create_ghost_dir(&additional_a, "extra_ghost_a")?;
        create_ghost_dir(&additional_b, "extra_ghost_b")?;

        let ordered = vec![
            additional_a.to_string_lossy().to_string(),
            additional_b.to_string_lossy().to_string(),
        ];
        let reversed = vec![
            additional_b.to_string_lossy().to_string(),
            additional_a.to_string_lossy().to_string(),
        ];

        let fingerprint_ordered = build_fingerprint(&ssp_root.to_string_lossy(), &ordered)?;
        let fingerprint_reversed = build_fingerprint(&ssp_root.to_string_lossy(), &reversed)?;

        assert_eq!(fingerprint_ordered, fingerprint_reversed);
        Ok(())
    }

    #[test]
    fn scan_ghosts_internal_collects_sources() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_scan_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost)
            .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
        create_ghost_dir_with_descript(&ssp_ghost, "ssp_dir", "name,zulu\ncharset,UTF-8\n")?;

        let additional_a = workspace.path().join("additional_a");
        let additional_b = workspace.path().join("additional_b");
        fs::create_dir_all(&additional_a)
            .map_err(|error| format!("failed to create additional_a: {}", error))?;
        fs::create_dir_all(&additional_b)
            .map_err(|error| format!("failed to create additional_b: {}", error))?;
        create_ghost_dir_with_descript(&additional_a, "extra_a", "name,Alpha\ncharset,UTF-8\n")?;
        create_ghost_dir_with_descript(&additional_b, "extra_b", "name,bravo\ncharset,UTF-8\n")?;

        let additional_paths = vec![
            additional_b.to_string_lossy().to_string(),
            additional_a.to_string_lossy().to_string(),
        ];
        let (ghosts, _) =
            scan_ghosts_with_fingerprint_internal(&ssp_root.to_string_lossy(), &additional_paths)?;

        assert_eq!(ghosts.len(), 3);
        let mut names: Vec<&str> = ghosts.iter().map(|g| g.name.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["Alpha", "bravo", "zulu"]);

        let ssp_ghost_item = ghosts
            .iter()
            .find(|ghost| ghost.directory_name == "ssp_dir")
            .ok_or_else(|| "ssp ghost not found".to_string())?;
        assert_eq!(ssp_ghost_item.source, "ssp");

        let extra_a = ghosts
            .iter()
            .find(|ghost| ghost.directory_name == "extra_a")
            .ok_or_else(|| "extra_a ghost not found".to_string())?;
        assert_eq!(extra_a.source, additional_a.to_string_lossy());

        let extra_b = ghosts
            .iter()
            .find(|ghost| ghost.directory_name == "extra_b")
            .ok_or_else(|| "extra_b ghost not found".to_string())?;
        assert_eq!(extra_b.source, additional_b.to_string_lossy());

        Ok(())
    }

    #[test]
    fn scan_ghosts_internal_extracts_craftman_field() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_craftman_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost)
            .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
        create_ghost_dir_with_descript(
            &ssp_ghost,
            "with_craftman",
            "name,テストゴースト\ncraftman,プログラム\ncharset,UTF-8\n",
        )?;
        create_ghost_dir_with_descript(
            &ssp_ghost,
            "without_craftman",
            "name,作者なし\ncharset,UTF-8\n",
        )?;

        let (ghosts, _) = scan_ghosts_with_fingerprint_internal(&ssp_root.to_string_lossy(), &[])?;

        let with_craftman = ghosts
            .iter()
            .find(|ghost| ghost.directory_name == "with_craftman")
            .ok_or_else(|| "with_craftman ghost not found".to_string())?;
        assert_eq!(with_craftman.craftman, "プログラム");

        let without_craftman = ghosts
            .iter()
            .find(|ghost| ghost.directory_name == "without_craftman")
            .ok_or_else(|| "without_craftman ghost not found".to_string())?;
        assert_eq!(without_craftman.craftman, "");

        Ok(())
    }

    #[test]
    fn scan_ghosts_internal_falls_back_to_directory_name_without_name_field() -> Result<(), String>
    {
        let workspace = TempDirGuard::new("ghost_launcher_scan_fallback_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost)
            .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
        create_ghost_dir_with_descript(
            &ssp_ghost,
            "fallback_dir",
            "charset,UTF-8\n// no name field\n",
        )?;

        let (ghosts, _) = scan_ghosts_with_fingerprint_internal(&ssp_root.to_string_lossy(), &[])?;
        let fallback = ghosts
            .iter()
            .find(|ghost| ghost.directory_name == "fallback_dir")
            .ok_or_else(|| "fallback ghost not found".to_string())?;
        assert_eq!(fallback.name, "fallback_dir");
        assert_eq!(fallback.source, "ssp");
        Ok(())
    }

    #[test]
    fn scan_ghosts_internal_returns_error_when_ssp_ghost_dir_is_missing() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_missing_ghost_dir_test");
        let ssp_root = workspace.path().join("ssp_without_ghost");
        fs::create_dir_all(&ssp_root)
            .map_err(|error| format!("failed to create ssp root dir: {}", error))?;

        let result = scan_ghosts_with_fingerprint_internal(&ssp_root.to_string_lossy(), &[]);
        assert!(result.is_err());
        let error = result.err().ok_or_else(|| "expected error".to_string())?;
        assert!(error.contains("ghost フォルダが見つかりません"));
        Ok(())
    }

    #[test]
    fn fingerprint_with_missing_additional_folder_matches_scan_fingerprint() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_missing_folder_fp_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost)
            .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
        create_ghost_dir(&ssp_ghost, "test_ghost")?;

        // 存在しない追加フォルダ（missing ケース）
        let nonexistent = workspace.path().join("nonexistent_folder");
        // 存在するがファイル（not-directory ケース）
        let not_a_dir = workspace.path().join("not_a_dir.txt");
        fs::write(&not_a_dir, "").map_err(|error| format!("failed to create file: {}", error))?;

        let additional_folders = vec![
            nonexistent.to_string_lossy().to_string(),
            not_a_dir.to_string_lossy().to_string(),
        ];
        let ssp_path = ssp_root.to_string_lossy().to_string();

        let standalone = build_fingerprint(&ssp_path, &additional_folders)?;
        let (_, integrated) =
            scan_ghosts_with_fingerprint_internal(&ssp_path, &additional_folders)?;

        assert_eq!(standalone, integrated);
        Ok(())
    }

    #[test]
    fn integrated_fingerprint_matches_standalone_build_fingerprint() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_fp_consistency_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost)
            .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
        create_ghost_dir(&ssp_ghost, "ghost_a")?;
        create_ghost_dir(&ssp_ghost, "ghost_b")?;

        let additional = workspace.path().join("additional");
        fs::create_dir_all(&additional)
            .map_err(|error| format!("failed to create additional: {}", error))?;
        create_ghost_dir(&additional, "extra_ghost")?;

        let additional_folders = vec![additional.to_string_lossy().to_string()];
        let ssp_path = ssp_root.to_string_lossy().to_string();

        let standalone = build_fingerprint(&ssp_path, &additional_folders)?;
        let (_, integrated) =
            scan_ghosts_with_fingerprint_internal(&ssp_path, &additional_folders)?;

        assert_eq!(standalone, integrated);
        Ok(())
    }

    /// 回帰: 子ディレクトリが junction（reparse point）でも、その先が実体ディレクトリなら
    /// ゴーストとして収集されること。`Path::is_dir()` は junction を辿るため現状も拾える。
    /// walk_parent の子絞り込みを `file_type()`（reparse point を false と返す）へ置換する際、
    /// symlink/junction を取りこぼさないフォールバックが要ることを縛る。
    /// junction は特権不要のため CI(windows-latest) でも実行できる（symlink は Developer Mode 必須）。
    #[cfg(windows)]
    #[test]
    fn scan_ghosts_internal_collects_junction_linked_ghost() -> Result<(), String> {
        use std::process::Command;

        let workspace = TempDirGuard::new("ghost_launcher_junction_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost)
            .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
        // 通常の実体ゴースト（回帰の基準・junction が通常収集を壊さないこと）
        create_ghost_dir_with_descript(&ssp_ghost, "normal_ghost", "name,Normal\ncharset,UTF-8\n")?;

        // junction の実体をツリー外に作る（ssp/ghost の直下ではない）
        let external = workspace.path().join("external");
        create_ghost_dir_with_descript(&external, "real_target", "name,Linked\ncharset,UTF-8\n")?;
        let target = external.join("real_target");
        let link = ssp_ghost.join("linked_ghost");

        // mklink /J は特権不要の directory junction を作る（cmd の内部コマンド）
        let status = Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&link)
            .arg(&target)
            .status()
            .map_err(|error| format!("mklink 起動に失敗: {}", error))?;
        assert!(status.success(), "mklink /J が失敗した: {:?}", status);

        let (ghosts, _) = scan_ghosts_with_fingerprint_internal(&ssp_root.to_string_lossy(), &[])?;

        assert!(
            ghosts.iter().any(|g| g.name == "Normal"),
            "通常ゴーストが収集されていない"
        );
        assert!(
            ghosts.iter().any(|g| g.name == "Linked"),
            "junction 越しのゴーストが取りこぼされた"
        );
        Ok(())
    }

    /// delta walk（scan_entries_with_fingerprint）の fingerprint が production walk
    /// （scan_ghosts_with_fingerprint_internal）と同一ツリーでバイト一致すること。
    /// 2 実装の drift ガード（Layer2 等値判定・getCachedFingerprint 往復契約の前提）。
    /// present／no-descript／追加フォルダ／存在しない追加フォルダの全トークン種を含める。
    #[test]
    fn scan_entries_fingerprint_matches_full_scan() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_delta_parity_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost).map_err(|e| format!("ssp ghost dir: {e}"))?;
        create_ghost_dir_with_descript(&ssp_ghost, "alpha", "name,Alpha\ncharset,UTF-8\n")?;
        create_ghost_dir_with_descript(&ssp_ghost, "bravo", "name,Bravo\ncharset,UTF-8\n")?;
        // descript を持たない子（token は出るが is_present=false・ghost にはならない）
        fs::create_dir_all(ssp_ghost.join("no_descript"))
            .map_err(|e| format!("no_descript dir: {e}"))?;

        let additional = workspace.path().join("additional");
        fs::create_dir_all(&additional).map_err(|e| format!("additional dir: {e}"))?;
        create_ghost_dir_with_descript(&additional, "charlie", "name,Charlie\ncharset,UTF-8\n")?;
        // 存在しない追加フォルダ（absent-parent トークン）
        let missing = workspace.path().join("missing_folder");

        let additional_folders = vec![
            additional.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
        ];
        let ssp_path = ssp_root.to_string_lossy().to_string();

        let (ghosts, full_fp) =
            scan_ghosts_with_fingerprint_internal(&ssp_path, &additional_folders)?;
        let (entries, delta_fp) =
            super::scan::scan_entries_with_fingerprint(&ssp_path, &additional_folders)?;

        // fingerprint がバイト一致（2 walk 実装の drift ガード）
        assert_eq!(full_fp, delta_fp, "delta walk の fingerprint が production walk と不一致");

        // present エントリ数 = ghost 数（no_descript は present=false のため除外）
        let present = entries.iter().filter(|e| e.is_present).count();
        assert_eq!(present, ghosts.len());
        assert_eq!(present, 3, "alpha/bravo/charlie の 3 present を期待");
        assert!(
            entries
                .iter()
                .any(|e| e.scan_key.ends_with("no_descript") && !e.is_present),
            "no_descript は entries に含まれ is_present=false であるべき"
        );
        Ok(())
    }

    /// walk 時に scan_entries へ保存する identity_key が、parse 済み Ghost から算出する
    /// identity と一致すること（削除子の ghosts 操作・一意性ガードの狙い先が正しいことを固定）。
    #[test]
    fn scan_entry_identity_key_matches_parsed_ghost() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_delta_identity_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost).map_err(|e| format!("ssp ghost dir: {e}"))?;
        create_ghost_dir_with_descript(&ssp_ghost, "alpha", "name,Alpha\ncharset,UTF-8\n")?;

        let (entries, _) =
            super::scan::scan_entries_with_fingerprint(&ssp_root.to_string_lossy(), &[])?;
        let entry = entries
            .iter()
            .find(|e| e.is_present)
            .ok_or_else(|| "present entry not found".to_string())?;
        let ghost = super::scan::parse_entry(entry).ok_or_else(|| "parse failed".to_string())?;

        assert_eq!(
            entry.identity_key,
            super::store::ghost_identity_key(&ghost.source, &ghost.directory_name)
        );
        Ok(())
    }

    /// 一意性ガード: NFKC 畳み込みで別ディレクトリが同一 identity へ落ちる衝突を loud に弾く。
    /// walk は不変子も含む全 present エントリを返すため、「新規が不変既存に畳み込む」ケースも
    /// このガードで捕捉できる（delta の parse-skip で失われる DB 側 loud 性の単一代替）。
    #[test]
    fn check_identity_uniqueness_が_nfkc_衝突を_loud_に弾く() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_uniqueness_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost).map_err(|e| format!("ssp ghost dir: {e}"))?;
        // "Ａ"（全角 U+FF21）と "a"（ASCII）は NFKC + lower で同一 identity "ssp\x1fa" に畳み込まれる。
        // 生の scan_key（生 directory_name）は別物ゆえ、物理的に別ディレクトリが同一キーへ落ちる衝突。
        create_ghost_dir_with_descript(&ssp_ghost, "Ａ", "name,Fullwidth\ncharset,UTF-8\n")?;
        create_ghost_dir_with_descript(&ssp_ghost, "a", "name,Ascii\ncharset,UTF-8\n")?;

        let (entries, _) =
            super::scan::scan_entries_with_fingerprint(&ssp_root.to_string_lossy(), &[])?;
        assert!(
            super::scan::check_identity_uniqueness(&entries).is_err(),
            "NFKC 衝突が loud に弾かれていない（サイレント消失＋path 振動への退行）"
        );
        Ok(())
    }

    #[test]
    fn check_identity_uniqueness_が衝突なしで通る() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_uniqueness_ok_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost).map_err(|e| format!("ssp ghost dir: {e}"))?;
        create_ghost_dir_with_descript(&ssp_ghost, "alpha", "name,Alpha\ncharset,UTF-8\n")?;
        create_ghost_dir_with_descript(&ssp_ghost, "bravo", "name,Bravo\ncharset,UTF-8\n")?;

        let (entries, _) =
            super::scan::scan_entries_with_fingerprint(&ssp_root.to_string_lossy(), &[])?;
        assert!(super::scan::check_identity_uniqueness(&entries).is_ok());
        Ok(())
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
        let total1 = super::apply_scan_delta(&conn, "rk1", &entries_all, &fp1, "mt-1")?;
        assert_eq!(total1, 3);

        // 移行を模す: scan_entries を空にする（旧 DB は ghosts のみで scan_entries を持たない）
        conn.execute("DELETE FROM ghost_scan_entries WHERE request_key = ?1", ["rk1"])
            .unwrap();

        // C をディスクから削除して再スキャン → walk は A,B のみを返す
        fs::remove_dir_all(ssp_ghost.join("c")).map_err(|e| format!("remove c: {e}"))?;
        let (entries_bc, fp2) = super::scan::scan_entries_with_fingerprint(&ssp_path, &[])?;
        let total2 = super::apply_scan_delta(&conn, "rk1", &entries_bc, &fp2, "mt-2")?;

        assert_eq!(total2, 2, "取り残し C が削除されていない（永久幽霊ゴースト）");
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
    fn apply_scan_delta_が非present兄弟のnfkc畳み込みで生存ゴーストを消さない() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_delta_fold_delete_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost).map_err(|e| format!("ssp ghost dir: {e}"))?;
        create_ghost_dir_with_descript(&ssp_ghost, "Ａ", "name,Fullwidth\ncharset,UTF-8\n")?;

        let conn = in_memory_ghost_db();
        let ssp_path = ssp_root.to_string_lossy().to_string();

        // 初回シード: Ａ を書き込む
        let (e1, fp1) = super::scan::scan_entries_with_fingerprint(&ssp_path, &[])?;
        super::apply_scan_delta(&conn, "rk1", &e1, &fp1, "mt-1")?;

        // 非 present の "a"（descript 無しディレクトリ）を追加 → 再スキャン
        fs::create_dir_all(ssp_ghost.join("a")).map_err(|e| format!("create a: {e}"))?;
        let (e2, fp2) = super::scan::scan_entries_with_fingerprint(&ssp_path, &[])?;
        let total = super::apply_scan_delta(&conn, "rk1", &e2, &fp2, "mt-2")?;

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
        super::apply_scan_delta(&conn, "rk1", &e1, &fp1, "mt-1")?;

        // 内容だけ書き換え、descript の mtime を元に戻して token を不変に保つ
        // （親 dir mtime は深い書込では変化しない・descript mtime のみ復元すれば token 不変）
        fs::write(&descript, "name,Modified\ncharset,UTF-8\n").map_err(|e| format!("rewrite: {e}"))?;
        let f = fs::OpenOptions::new()
            .write(true)
            .open(&descript)
            .map_err(|e| format!("reopen: {e}"))?;
        f.set_modified(orig_mtime)
            .map_err(|e| format!("set_modified: {e}"))?;
        drop(f);

        // 再スキャン → token 不変 → delta は alpha を再 parse しない
        let (e2, fp2) = super::scan::scan_entries_with_fingerprint(&ssp_path, &[])?;
        super::apply_scan_delta(&conn, "rk1", &e2, &fp2, "mt-2")?;

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

    /// migrations 適用済みのファイル ghosts DB を開く（並行テスト用・接続はスレッド毎に開く）。
    fn open_file_ghost_db(path: &std::path::Path) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open(path).unwrap();
        // 新規ファイルなら全 migration を適用、既存なら全 skip（open_bench_db と同方針）。
        let has_schema: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='ghosts'",
                [],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !has_schema {
            let mut sorted = crate::migrations();
            sorted.sort_by_key(|m| m.version);
            for m in &sorted {
                conn.execute_batch(m.sql).unwrap();
            }
        }
        super::store::configure_connection(&conn).unwrap();
        conn
    }

    #[test]
    fn scan_lock配下の並行deltaが整合状態を壊さない() {
        use crate::scan_coordinator::ScanCoordinator;
        use std::sync::{Arc, Barrier};
        use std::thread;

        // 2 つの ssp ツリー（片方は ghost_a、もう片方は ghost_b）を用意する。
        let tmp = TempDirGuard::new("scan_serialize");
        let ssp_a = tmp.path().join("ssp_a");
        let ssp_b = tmp.path().join("ssp_b");
        fs::create_dir_all(ssp_a.join("ghost")).unwrap();
        fs::create_dir_all(ssp_b.join("ghost")).unwrap();
        create_ghost_dir(&ssp_a.join("ghost"), "ghost_a").unwrap();
        create_ghost_dir(&ssp_b.join("ghost"), "ghost_b").unwrap();

        let db = tmp.path().join("ghosts.db");
        open_file_ghost_db(&db); // 初期化（テーブル作成）

        let coord = ScanCoordinator::default();
        let barrier = Arc::new(Barrier::new(2));

        // 同一 request_key "rk" に、異なる entries を並行に delta 適用する。
        let ssps = [ssp_a, ssp_b];
        let handles: Vec<_> = ssps
            .into_iter()
            .map(|ssp| {
                let coord = coord.clone();
                let barrier = barrier.clone();
                let db = db.clone();
                thread::spawn(move || {
                    let ssp_str = ssp.to_string_lossy().to_string();
                    let (entries, fp) =
                        super::scan::scan_entries_with_fingerprint(&ssp_str, &[]).unwrap();
                    let conn = open_file_ghost_db(&db);
                    barrier.wait(); // 両スレッドを同時に走らせる
                    let _guard = coord.0.lock().unwrap_or_else(|e| e.into_inner());
                    super::apply_scan_delta(&conn, "rk", &entries, &fp, "mtimes").unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        // 直列化されているため、最終状態は「後に走った方の entries」に整合した 1 状態。
        // ghosts と ghost_scan_entries の件数が一致し（混合・破損なし）、1 件であること。
        let conn = open_file_ghost_db(&db);
        let ghosts: i64 = conn
            .query_row("SELECT COUNT(*) FROM ghosts WHERE request_key='rk'", [], |r| r.get(0))
            .unwrap();
        let entries: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ghost_scan_entries WHERE request_key='rk'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ghosts, 1, "直列化後は 1 体（後勝ちの entries）のはず");
        assert_eq!(ghosts, entries, "ghosts と scan_entries が整合しているはず");
    }
}
