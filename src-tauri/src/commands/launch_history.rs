use rusqlite::Connection;
use tauri::Manager;

/// user-data.db に起動履歴テーブルを冪等に用意する。
/// ここは sqlx マイグレーション系に載せない（永続ストアなので自動削除の事故クラスが構造上発生しない）。
pub(crate) fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ghost_launches (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  ghost_identity_key TEXT NOT NULL,\n  launched_at TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_ghost_launches_identity ON ghost_launches(ghost_identity_key);\nCREATE INDEX IF NOT EXISTS idx_ghost_launches_at ON ghost_launches(launched_at DESC);",
    )
    .map_err(|e| format!("user-data スキーマ作成エラー: {e}"))
}

/// user-data.db を開き、書込用 PRAGMA を適用し、スキーマを用意して返す。
pub(crate) fn open_user_data_db<R: tauri::Runtime>(
    manager: &impl Manager<R>,
) -> Result<Connection, String> {
    let path = crate::db_path::user_data_db_path(manager)?;
    let conn = Connection::open(&path).map_err(|e| format!("user-data.db オープンエラー: {e}"))?;
    crate::commands::ghost::store::configure_connection(&conn)?;
    ensure_schema(&conn)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_schemaはghost_launchesテーブルを冪等に作る() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        // 二重呼び出しでも失敗しない（IF NOT EXISTS）
        ensure_schema(&conn).unwrap();

        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(ghost_launches)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(cols.contains(&"ghost_identity_key".to_string()));
        assert!(cols.contains(&"launched_at".to_string()));
    }
}
