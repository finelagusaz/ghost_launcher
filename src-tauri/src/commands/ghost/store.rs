use rusqlite::Connection;
use unicode_normalization::UnicodeNormalization;

use super::types::Ghost;

const GHOST_KEY_SEPARATOR: char = '\x1f';

/// NFKC 正規化 + 小文字化（JS 側の normalizeForKey と同一ロジック）
fn normalize_for_key(s: &str) -> String {
    s.nfkc().collect::<String>().to_lowercase()
}

/// ghost_identity_key を構築する（JS 側の buildGhostIdentityKey と同一ロジック）
fn build_ghost_identity_key(ghost: &Ghost) -> String {
    format!(
        "{}{}{}",
        normalize_for_key(&ghost.source),
        GHOST_KEY_SEPARATOR,
        normalize_for_key(&ghost.directory_name)
    )
}

/// rusqlite 接続に書き込み用 PRAGMA を設定する
pub(crate) fn configure_connection(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;\
         PRAGMA busy_timeout=5000;",
    )
    .map_err(|e| format!("PRAGMA 設定エラー: {e}"))
}

/// ゴースト一覧を SQLite に直接書き込む（DELETE + INSERT、1 トランザクション）。
/// fingerprint と parent_mtimes も同一トランザクション内で保存する。
pub(crate) fn store_ghosts(
    conn: &Connection,
    request_key: &str,
    ghosts: &[Ghost],
    fingerprint: &str,
    parent_mtimes: &str,
) -> Result<usize, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("トランザクション開始エラー: {e}"))?;

    // 既存データを削除
    tx.execute("DELETE FROM ghosts WHERE request_key = ?1", [request_key])
        .map_err(|e| format!("DELETE エラー: {e}"))?;

    // prepared statement で一括 INSERT（stmt のスコープを制限して tx.commit() 前に drop）
    {
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
                )",
            )
            .map_err(|e| format!("INSERT 準備エラー: {e}"))?;

        for ghost in ghosts {
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
            .map_err(|e| format!("INSERT エラー: {e}"))?;
        }

        // fingerprint + parent_mtimes を同一トランザクションで保存
        tx.execute(
            "INSERT OR REPLACE INTO ghost_fingerprints (request_key, fingerprint, parent_mtimes, updated_at)\
             VALUES (?1, ?2, ?3, datetime('now'))",
            rusqlite::params![request_key, fingerprint, parent_mtimes],
        )
        .map_err(|e| format!("fingerprint 保存エラー: {e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("コミットエラー: {e}"))?;

    Ok(ghosts.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations;

    /// テスト用にマイグレーション適用済みの in-memory DB を作成する
    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        let mut sorted = migrations();
        sorted.sort_by_key(|m| m.version);
        for m in &sorted {
            conn.execute_batch(m.sql).unwrap();
        }
        // ghost_fingerprints テーブルも作成されていることを確認
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _sqlx_migrations (version BIGINT PRIMARY KEY)",
        )
        .unwrap();
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
    fn store_ghosts_が空の配列で成功する() {
        let conn = setup_db();
        let result = store_ghosts(&conn, "rk1", &[], "fp-empty", "");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 0);
    }

    #[test]
    fn store_ghosts_がゴーストを挿入し件数を返す() {
        let conn = setup_db();
        let ghosts = vec![
            make_ghost("Alice", "alice", "ssp"),
            make_ghost("Bob", "bob", "ssp"),
        ];
        let total = store_ghosts(&conn, "rk1", &ghosts, "fp-test", "mtimes").unwrap();
        assert_eq!(total, 2);

        // DB から件数確認
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ghosts WHERE request_key = ?1",
                ["rk1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn store_ghosts_が_lower_カラムを_nfkc_正規化して格納する() {
        let conn = setup_db();
        // 全角英字 "Ａｌｉｃｅ" → NFKC → "Alice" → lower → "alice"
        let ghosts = vec![make_ghost("Ａｌｉｃｅ", "alice_dir", "ssp")];
        store_ghosts(&conn, "rk1", &ghosts, "fp-nfkc", "").unwrap();

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
    fn store_ghosts_が既存データを置換する() {
        let conn = setup_db();
        let ghosts_v1 = vec![make_ghost("Old", "old", "ssp")];
        store_ghosts(&conn, "rk1", &ghosts_v1, "fp-v1", "mt-v1").unwrap();

        let ghosts_v2 = vec![
            make_ghost("New1", "new1", "ssp"),
            make_ghost("New2", "new2", "ssp"),
        ];
        store_ghosts(&conn, "rk1", &ghosts_v2, "fp-v2", "mt-v2").unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ghosts WHERE request_key = ?1",
                ["rk1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2); // Old は消えて New1, New2 のみ

        // fingerprint も更新されている
        let fp: String = conn
            .query_row(
                "SELECT fingerprint FROM ghost_fingerprints WHERE request_key = ?1",
                ["rk1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fp, "fp-v2");
    }

    #[test]
    fn store_ghosts_が異なる_request_key_のデータに影響しない() {
        let conn = setup_db();
        let ghosts_a = vec![make_ghost("A", "a", "ssp")];
        let ghosts_b = vec![make_ghost("B", "b", "ssp")];
        store_ghosts(&conn, "rk-a", &ghosts_a, "fp-a", "").unwrap();
        store_ghosts(&conn, "rk-b", &ghosts_b, "fp-b", "").unwrap();

        let count_a: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ghosts WHERE request_key = ?1",
                ["rk-a"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count_a, 1);
    }

    #[test]
    fn store_ghosts_が_fingerprint_を保存する() {
        let conn = setup_db();
        store_ghosts(&conn, "rk1", &[], "fp-123abc", "mt-test").unwrap();

        let fp: String = conn
            .query_row(
                "SELECT fingerprint FROM ghost_fingerprints WHERE request_key = ?1",
                ["rk1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fp, "fp-123abc");
    }

    #[test]
    fn store_ghosts_が_ghost_identity_key_を正しく構築する() {
        let conn = setup_db();
        let ghosts = vec![make_ghost("Test", "test_dir", "ssp")];
        store_ghosts(&conn, "rk1", &ghosts, "fp-id", "").unwrap();

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
    fn store_ghosts_が_parent_mtimes_を保存する() {
        let conn = setup_db();
        store_ghosts(&conn, "rk1", &[], "fp-1", "c:/ssp/ghost:12345\nc:/extra:67890").unwrap();

        let mtimes: String = conn
            .query_row(
                "SELECT parent_mtimes FROM ghost_fingerprints WHERE request_key = ?1",
                ["rk1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(mtimes, "c:/ssp/ghost:12345\nc:/extra:67890");
    }

    #[test]
    fn check_parent_mtimes_match_が一致時にtrueを返す() {
        let conn = setup_db();
        store_ghosts(&conn, "rk1", &[], "fp-1", "c:/ssp/ghost:12345").unwrap();

        assert!(super::super::fingerprint::check_parent_mtimes_match(
            &conn,
            "rk1",
            "c:/ssp/ghost:12345"
        ));
    }

    #[test]
    fn check_parent_mtimes_match_が不一致時にfalseを返す() {
        let conn = setup_db();
        store_ghosts(&conn, "rk1", &[], "fp-1", "c:/ssp/ghost:12345").unwrap();

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
    fn normalize_for_key_が_nfkc_正規化と小文字化を行う() {
        assert_eq!(normalize_for_key("Ａｌｉｃｅ"), "alice");
        assert_eq!(normalize_for_key("HELLO"), "hello");
        assert_eq!(normalize_for_key("テスト"), "テスト");
        assert_eq!(normalize_for_key(""), "");
    }
}
