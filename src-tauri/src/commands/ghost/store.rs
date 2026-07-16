use std::collections::HashMap;

use rusqlite::Connection;
use unicode_normalization::UnicodeNormalization;

use super::types::Ghost;

const GHOST_KEY_SEPARATOR: char = '\x1f';

/// NFKC 正規化 + 小文字化（JS 側の normalizeForKey と同一ロジック）
fn normalize_for_key(s: &str) -> String {
    s.nfkc().collect::<String>().to_lowercase()
}

/// source と directory_name から ghost_identity_key を構築する（論理主キー・単一権威）。
/// 走査層（delta walk）と store の双方がこの関数を呼ぶことで、walk 時に scan_entries へ
/// 保存する identity と、parse 済み Ghost から算出する identity のバイト一致を保証する。
pub(crate) fn ghost_identity_key(source: &str, directory_name: &str) -> String {
    format!(
        "{}{}{}",
        normalize_for_key(source),
        GHOST_KEY_SEPARATOR,
        normalize_for_key(directory_name)
    )
}

/// ghost_identity_key を構築する（Rust のみで計算し DB 列に書く。JS は列値を読むだけで再計算しない）
fn build_ghost_identity_key(ghost: &Ghost) -> String {
    ghost_identity_key(&ghost.source, &ghost.directory_name)
}

/// rusqlite 接続に書き込み用 PRAGMA を設定する
pub(crate) fn configure_connection(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;\
         PRAGMA busy_timeout=5000;\
         PRAGMA synchronous=NORMAL;\
         PRAGMA cache_size=-65536;\
         PRAGMA temp_store=MEMORY;\
         PRAGMA mmap_size=134217728;",
    )
    .map_err(|e| format!("PRAGMA 設定エラー: {e}"))
}

/// 指定 request_key の既存 ghosts の ghost_identity_key を全件読む（カバリング index）。
/// 前回 scan_entries が空の初回/移行スキャン時のみ呼ばれ、走査に現れない取り残しゴースト
/// （旧コードで書かれた行や cleanupOldGhostCaches のズレ）を set-difference で検出する。
/// 定常の delta 経路（前回 scan_entries 非空）では呼ばない O(既存件数) の読み。
pub(crate) fn read_ghost_identities(
    conn: &Connection,
    request_key: &str,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare_cached("SELECT ghost_identity_key FROM ghosts WHERE request_key = ?1")
        .map_err(|e| format!("identities SELECT 準備エラー: {e}"))?;
    let ids = stmt
        .query_map([request_key], |row| row.get::<_, String>(0))
        .map_err(|e| format!("identities SELECT エラー: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(ids)
}

/// ghost_scan_entries への UPSERT 行（借用）。scan 層（ScanEntry）と store を疎結合に保つ。
pub(crate) struct ScanEntryRow<'a> {
    pub scan_key: &'a str,
    pub token: &'a str,
    pub identity_key: &'a str,
}

/// 前回の scan_entries を (scan_key -> (token, ghost_identity_key)) で読む（delta 差分の前回状態）。
/// カバリング（WITHOUT ROWID）を全行スキャンする O(N) 読み。
pub(crate) fn read_scan_entries(
    conn: &Connection,
    request_key: &str,
) -> Result<HashMap<String, (String, String)>, String> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT scan_key, token, ghost_identity_key \
             FROM ghost_scan_entries WHERE request_key = ?1",
        )
        .map_err(|e| format!("scan_entries SELECT 準備エラー: {e}"))?;
    let map = stmt
        .query_map([request_key], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (row.get::<_, String>(1)?, row.get::<_, String>(2)?),
            ))
        })
        .map_err(|e| format!("scan_entries SELECT エラー: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(map)
}

/// delta 差分書き込み（1 トランザクション）。全行読み取りをせず、変更子だけを操作する。
///
/// - `upserts`: 変更子（parse 成功）。`ON CONFLICT … DO UPDATE … WHERE row_fingerprint 相違` で、
///   新規は INSERT・メタ変化は UPDATE・不変は no-op（updated_at を bump しない）。初回/移行時
///   （ghosts 既存・scan_entries 空）でも UNIQUE 衝突せず UPDATE で吸収する。
/// - `deletes`: DELETE 対象 `ghost_identity_key`（削除子＋parse 失敗子）。upsert より先に適用する。
/// - `scan_upserts` / `scan_deletes`: `ghost_scan_entries` の差分（変更子を UPSERT・削除子を DELETE）。
/// - `fingerprint` / `parent_mtimes`: `ghost_fingerprints` を更新（0 子変更でも必ず書き、次回 Layer 1 を再 hit させる）。
/// - 集計列 `last_launched` / `launch_count` は不可侵（INSERT 時は既定値・UPDATE 時は無触）。commit 後に backfill する。
///
/// 同一スキャン内の identity 衝突（NFKC 畳み込み）は呼び出し側の in-memory 一意性ガードが loud に
/// 弾く前提。ここでは DB 書込を一意性の番人にしない（不変子スキップで DB 側 UNIQUE の loud 性は
/// 失われるため、ガードを単一権威にする）。戻り値 total = 適用後の ghosts 件数（SELECT COUNT(*)）。
pub(crate) fn store_ghosts_delta(
    conn: &Connection,
    request_key: &str,
    upserts: &[Ghost],
    deletes: &[String],
    scan_upserts: &[ScanEntryRow],
    scan_deletes: &[String],
    fingerprint: &str,
    parent_mtimes: &str,
) -> Result<usize, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("トランザクション開始エラー: {e}"))?;

    {
        // 1) DELETE（削除子＋parse 失敗子）を先に適用する。
        //    NFKC 衝突の corner（同一 identity の削除子と upsert が併存）で upsert を勝たせる。
        if !deletes.is_empty() {
            let mut stmt = tx
                .prepare_cached(
                    "DELETE FROM ghosts WHERE request_key = ?1 AND ghost_identity_key = ?2",
                )
                .map_err(|e| format!("DELETE 準備エラー: {e}"))?;
            for identity_key in deletes {
                stmt.execute(rusqlite::params![request_key, identity_key])
                    .map_err(|e| format!("DELETE エラー: {e}"))?;
            }
        }

        // 2) 変更子を UPSERT（INSERT / 既存は row_fingerprint 相違時のみ UPDATE）。
        if !upserts.is_empty() {
            let mut stmt = tx
                .prepare_cached(
                    "INSERT INTO ghosts (\
                        request_key, ghost_identity_key, row_fingerprint,\
                        name, sakura_name, kero_name, craftman, craftmanw,\
                        directory_name, path, source,\
                        name_lower, sakura_name_lower, kero_name_lower,\
                        craftman_lower, craftmanw_lower, directory_name_lower,\
                        thumbnail_path, thumbnail_use_self_alpha, thumbnail_kind,\
                        updated_at\
                    ) VALUES (\
                        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,\
                        ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,\
                        datetime('now')\
                    ) ON CONFLICT(request_key, ghost_identity_key) DO UPDATE SET \
                        row_fingerprint = excluded.row_fingerprint,\
                        name = excluded.name, sakura_name = excluded.sakura_name,\
                        kero_name = excluded.kero_name, craftman = excluded.craftman,\
                        craftmanw = excluded.craftmanw, directory_name = excluded.directory_name,\
                        path = excluded.path, source = excluded.source,\
                        name_lower = excluded.name_lower, sakura_name_lower = excluded.sakura_name_lower,\
                        kero_name_lower = excluded.kero_name_lower, craftman_lower = excluded.craftman_lower,\
                        craftmanw_lower = excluded.craftmanw_lower,\
                        directory_name_lower = excluded.directory_name_lower,\
                        thumbnail_path = excluded.thumbnail_path,\
                        thumbnail_use_self_alpha = excluded.thumbnail_use_self_alpha,\
                        thumbnail_kind = excluded.thumbnail_kind, updated_at = datetime('now')\
                    WHERE ghosts.row_fingerprint != excluded.row_fingerprint",
                )
                .map_err(|e| format!("UPSERT 準備エラー: {e}"))?;

            for ghost in upserts {
                let identity_key = build_ghost_identity_key(ghost);
                stmt.execute(rusqlite::params![
                    request_key,
                    identity_key,
                    ghost.diff_fingerprint,
                    ghost.name,
                    ghost.sakura_name,
                    ghost.kero_name,
                    ghost.craftman,
                    ghost.craftmanw,
                    ghost.directory_name,
                    ghost.path,
                    ghost.source,
                    normalize_for_key(&ghost.name),
                    normalize_for_key(&ghost.sakura_name),
                    normalize_for_key(&ghost.kero_name),
                    normalize_for_key(&ghost.craftman),
                    normalize_for_key(&ghost.craftmanw),
                    normalize_for_key(&ghost.directory_name),
                    ghost.thumbnail_path,
                    ghost.thumbnail_use_self_alpha as i32,
                    ghost.thumbnail_kind,
                ])
                .map_err(|e| format!("UPSERT エラー: {e}"))?;
            }
        }

        // 3) ghost_scan_entries の差分（削除子を DELETE・変更子を UPSERT）。不変子は無触。
        if !scan_deletes.is_empty() {
            let mut stmt = tx
                .prepare_cached(
                    "DELETE FROM ghost_scan_entries WHERE request_key = ?1 AND scan_key = ?2",
                )
                .map_err(|e| format!("scan_entries DELETE 準備エラー: {e}"))?;
            for scan_key in scan_deletes {
                stmt.execute(rusqlite::params![request_key, scan_key])
                    .map_err(|e| format!("scan_entries DELETE エラー: {e}"))?;
            }
        }
        if !scan_upserts.is_empty() {
            let mut stmt = tx
                .prepare_cached(
                    "INSERT OR REPLACE INTO ghost_scan_entries \
                     (request_key, scan_key, token, ghost_identity_key) VALUES (?1, ?2, ?3, ?4)",
                )
                .map_err(|e| format!("scan_entries UPSERT 準備エラー: {e}"))?;
            for row in scan_upserts {
                stmt.execute(rusqlite::params![
                    request_key,
                    row.scan_key,
                    row.token,
                    row.identity_key,
                ])
                .map_err(|e| format!("scan_entries UPSERT エラー: {e}"))?;
            }
        }

        // 4) fingerprint + parent_mtimes（0 子変更でも必ず書く）。
        tx.execute(
            "INSERT OR REPLACE INTO ghost_fingerprints (request_key, fingerprint, parent_mtimes, updated_at)\
             VALUES (?1, ?2, ?3, datetime('now'))",
            rusqlite::params![request_key, fingerprint, parent_mtimes],
        )
        .map_err(|e| format!("fingerprint 保存エラー: {e}"))?;
    }

    // 5) total は適用後の実件数（upserts.len() を流用しない・10万監視の閾値を壊さない）。
    let total: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM ghosts WHERE request_key = ?1",
            [request_key],
            |row| row.get(0),
        )
        .map_err(|e| format!("COUNT エラー: {e}"))?;

    tx.commit().map_err(|e| format!("コミットエラー: {e}"))?;

    Ok(total as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// テスト用に cache schema 適用済みの in-memory DB を作成する
    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::testutil::apply_cache_schema(&conn);
        conn
    }

    fn make_ghost(name: &str, dir: &str, source: &str) -> Ghost {
        Ghost {
            diff_fingerprint: format!("fp-{name}"),
            name: name.to_string(),
            sakura_name: String::new(),
            kero_name: String::new(),
            craftman: String::new(),
            craftmanw: String::new(),
            directory_name: dir.to_string(),
            path: format!("/ghosts/{dir}"),
            source: source.to_string(),
            thumbnail_path: String::new(),
            thumbnail_use_self_alpha: false,
            thumbnail_kind: String::new(),
        }
    }

    #[test]
    fn store_ghosts_delta_が_lower_カラムを_nfkc_正規化して格納する() {
        let conn = setup_db();
        // 全角英字 "Ａｌｉｃｅ" → NFKC → "Alice" → lower → "alice"
        let ghost = make_ghost("Ａｌｉｃｅ", "alice_dir", "ssp");
        let k = build_ghost_identity_key(&ghost);
        store_ghosts_delta(
            &conn,
            "rk1",
            std::slice::from_ref(&ghost),
            &[],
            &[scan_row("sk", "tok", &k)],
            &[],
            "fp-nfkc",
            "",
        )
        .unwrap();

        let name_lower: String = conn
            .query_row(
                "SELECT name_lower FROM ghosts WHERE request_key = ?1",
                ["rk1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(name_lower, "alice");
    }

    #[test]
    fn store_ghosts_delta_が_ghost_identity_key_を格納する() {
        let conn = setup_db();
        let ghost = make_ghost("Test", "test_dir", "ssp");
        let k = build_ghost_identity_key(&ghost);
        store_ghosts_delta(
            &conn,
            "rk1",
            std::slice::from_ref(&ghost),
            &[],
            &[scan_row("sk", "tok", &k)],
            &[],
            "fp-id",
            "",
        )
        .unwrap();

        let identity_key: String = conn
            .query_row(
                "SELECT ghost_identity_key FROM ghosts WHERE request_key = ?1",
                ["rk1"],
                |row| row.get(0),
            )
            .unwrap();
        // source="ssp" → normalize → "ssp", dir="test_dir" → normalize → "test_dir"
        let expected = format!("ssp{}test_dir", GHOST_KEY_SEPARATOR);
        assert_eq!(identity_key, expected);
    }

    #[test]
    fn check_parent_mtimes_match_が一致時にtrueを返す() {
        let conn = setup_db();
        store_ghosts_delta(&conn, "rk1", &[], &[], &[], &[], "fp-1", "c:/ssp/ghost:12345").unwrap();

        assert!(super::super::fingerprint::check_parent_mtimes_match(
            &conn,
            "rk1",
            "c:/ssp/ghost:12345"
        ));
    }

    #[test]
    fn check_parent_mtimes_match_が不一致時にfalseを返す() {
        let conn = setup_db();
        store_ghosts_delta(&conn, "rk1", &[], &[], &[], &[], "fp-1", "c:/ssp/ghost:12345").unwrap();

        assert!(!super::super::fingerprint::check_parent_mtimes_match(
            &conn,
            "rk1",
            "c:/ssp/ghost:99999"
        ));
    }

    #[test]
    fn check_parent_mtimes_match_がレコード未存在時にfalseを返す() {
        let conn = setup_db();

        assert!(!super::super::fingerprint::check_parent_mtimes_match(
            &conn,
            "rk-nonexistent",
            "c:/ssp/ghost:12345"
        ));
    }

    #[test]
    fn normalize_for_key_が共有_fixture_の期待値と一致する() {
        // JS の normalizeForKey と同一の fixture を参照し、言語間パリティを縛る。
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/test/fixtures/normalize-key-cases.json"
        );
        let raw = std::fs::read_to_string(path).expect("fixture を読めること");
        let cases: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
        for case in cases {
            let input = case["input"].as_str().unwrap();
            let expected = case["expected"].as_str().unwrap();
            assert_eq!(normalize_for_key(input), expected, "input={input:?}");
        }
    }

    // --- store_ghosts_delta ---

    /// テスト用に ghost 1 件分の scan_entry 行を組む（scan_key/token は差分検知用の任意値）。
    fn scan_row<'a>(scan_key: &'a str, token: &'a str, identity_key: &'a str) -> ScanEntryRow<'a> {
        ScanEntryRow {
            scan_key,
            token,
            identity_key,
        }
    }

    fn count_ghosts(conn: &Connection, rk: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM ghosts WHERE request_key = ?1",
            [rk],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn count_scan_entries(conn: &Connection, rk: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM ghost_scan_entries WHERE request_key = ?1",
            [rk],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn store_ghosts_delta_が新規をinsertしscan_entryを書く() {
        let conn = setup_db();
        let alice = make_ghost("Alice", "alice", "ssp");
        let bob = make_ghost("Bob", "bob", "ssp");
        let ka = build_ghost_identity_key(&alice);
        let kb = build_ghost_identity_key(&bob);

        let total = store_ghosts_delta(
            &conn,
            "rk1",
            &[alice, bob],
            &[],
            &[
                scan_row("sk-a", "tok-a", &ka),
                scan_row("sk-b", "tok-b", &kb),
            ],
            &[],
            "fp-1",
            "mt-1",
        )
        .unwrap();

        assert_eq!(total, 2);
        assert_eq!(count_ghosts(&conn, "rk1"), 2);
        assert_eq!(count_scan_entries(&conn, "rk1"), 2);

        let fp: String = conn
            .query_row(
                "SELECT fingerprint FROM ghost_fingerprints WHERE request_key = ?1",
                ["rk1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fp, "fp-1");
    }

    #[test]
    fn store_ghosts_delta_が変更子をupdateし不変子のupdated_atを保つ() {
        let conn = setup_db();
        let mut alice = make_ghost("Alice", "alice", "ssp");
        let ka = build_ghost_identity_key(&alice);
        store_ghosts_delta(
            &conn,
            "rk1",
            std::slice::from_ref(&alice),
            &[],
            &[scan_row("sk-a", "tok-a", &ka)],
            &[],
            "fp-1",
            "mt-1",
        )
        .unwrap();
        let updated_at_1: String = conn
            .query_row(
                "SELECT updated_at FROM ghosts WHERE request_key = ?1",
                ["rk1"],
                |row| row.get(0),
            )
            .unwrap();

        // row_fingerprint 一致の再 upsert（メタ不変）→ WHERE で UPDATE されず updated_at 不変
        store_ghosts_delta(
            &conn,
            "rk1",
            std::slice::from_ref(&alice),
            &[],
            &[scan_row("sk-a", "tok-a-changed", &ka)],
            &[],
            "fp-2",
            "mt-2",
        )
        .unwrap();
        let updated_at_2: String = conn
            .query_row(
                "SELECT updated_at FROM ghosts WHERE request_key = ?1",
                ["rk1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(updated_at_1, updated_at_2, "メタ不変なら updated_at は bump しない");

        // row_fingerprint 変化 → UPDATE される
        alice.diff_fingerprint = "fp-changed".to_string();
        alice.name = "Alice-Updated".to_string();
        store_ghosts_delta(
            &conn,
            "rk1",
            std::slice::from_ref(&alice),
            &[],
            &[scan_row("sk-a", "tok-a-2", &ka)],
            &[],
            "fp-3",
            "mt-3",
        )
        .unwrap();
        let name: String = conn
            .query_row(
                "SELECT name FROM ghosts WHERE request_key = ?1",
                ["rk1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(name, "Alice-Updated");
        assert_eq!(count_ghosts(&conn, "rk1"), 1);
    }

    #[test]
    fn store_ghosts_delta_が削除子をdeleteする() {
        let conn = setup_db();
        let alice = make_ghost("Alice", "alice", "ssp");
        let bob = make_ghost("Bob", "bob", "ssp");
        let ka = build_ghost_identity_key(&alice);
        let kb = build_ghost_identity_key(&bob);
        store_ghosts_delta(
            &conn,
            "rk1",
            &[alice, bob],
            &[],
            &[scan_row("sk-a", "tok-a", &ka), scan_row("sk-b", "tok-b", &kb)],
            &[],
            "fp-1",
            "mt-1",
        )
        .unwrap();

        // Bob を削除子として DELETE（identity と scan_key を渡す）
        let total = store_ghosts_delta(
            &conn,
            "rk1",
            &[],
            std::slice::from_ref(&kb),
            &[],
            std::slice::from_ref(&"sk-b".to_string()),
            "fp-2",
            "mt-2",
        )
        .unwrap();
        assert_eq!(total, 1);
        assert_eq!(count_ghosts(&conn, "rk1"), 1);
        assert_eq!(count_scan_entries(&conn, "rk1"), 1);
        let name: String = conn
            .query_row(
                "SELECT name FROM ghosts WHERE request_key = ?1",
                ["rk1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(name, "Alice");
    }

    #[test]
    fn store_ghosts_delta_が_0変更でもfingerprintとparent_mtimesを書く() {
        let conn = setup_db();
        let total =
            store_ghosts_delta(&conn, "rk1", &[], &[], &[], &[], "fp-only", "mt-only").unwrap();
        assert_eq!(total, 0);

        let (fp, mt): (String, String) = conn
            .query_row(
                "SELECT fingerprint, parent_mtimes FROM ghost_fingerprints WHERE request_key = ?1",
                ["rk1"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(fp, "fp-only");
        assert_eq!(mt, "mt-only");
    }

    #[test]
    fn store_ghosts_delta_が既存identityへのupsertでunique衝突しない() {
        // 既存 identity を「新規」として再 upsert しても ON CONFLICT で UPDATE 吸収し、UNIQUE で落ちない
        // （初回/移行時に既存 ghosts へ upsert する経路の土台）。
        let conn = setup_db();
        let alice = make_ghost("Alice", "alice", "ssp");
        let ka = build_ghost_identity_key(&alice);
        store_ghosts_delta(
            &conn,
            "rk1",
            std::slice::from_ref(&alice),
            &[],
            &[scan_row("sk-a", "tok-a", &ka)],
            &[],
            "fp-seed",
            "mt-seed",
        )
        .unwrap();

        // 同一 identity を別 scan_key（token 変化想定）で再 upsert → UNIQUE 衝突せず UPDATE
        let result = store_ghosts_delta(
            &conn,
            "rk1",
            std::slice::from_ref(&alice),
            &[],
            &[scan_row("sk-a", "tok-a-2", &ka)],
            &[],
            "fp-1",
            "mt-1",
        );
        assert!(result.is_ok(), "既存 identity への upsert が UNIQUE 衝突した: {result:?}");
        assert_eq!(count_ghosts(&conn, "rk1"), 1);
        assert_eq!(count_scan_entries(&conn, "rk1"), 1);
    }
}
