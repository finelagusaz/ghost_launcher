mod commands;

// マイグレーション追加時の注意:
//   ALTER TABLE ... ADD COLUMN ... DEFAULT <値> の <値> はリテラルのみ許容される。
//   CURRENT_TIMESTAMP や datetime('now') などの関数は SQLite が拒否する（起動時クラッシュ）。
//   正しい例: DEFAULT ''   誤った例: DEFAULT CURRENT_TIMESTAMP
//   実際の時刻は INSERT 時の VALUES 句で CURRENT_TIMESTAMP を使って設定すること。
pub(crate) fn migrations() -> Vec<tauri_plugin_sql::Migration> {
    vec![
        tauri_plugin_sql::Migration {
            version: 1,
            description: "create_ghosts_table",
            sql: "CREATE TABLE IF NOT EXISTS ghosts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                directory_name TEXT NOT NULL,
                path TEXT NOT NULL,
                source TEXT NOT NULL,
                name_lower TEXT NOT NULL,
                directory_name_lower TEXT NOT NULL
            );",
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 2,
            description: "add_request_key_to_ghosts",
            sql: "ALTER TABLE ghosts ADD COLUMN request_key TEXT NOT NULL DEFAULT '';\nCREATE INDEX IF NOT EXISTS idx_ghosts_request_key ON ghosts(request_key);\nCREATE INDEX IF NOT EXISTS idx_ghosts_request_key_name_lower ON ghosts(request_key, name_lower);\nCREATE INDEX IF NOT EXISTS idx_ghosts_request_key_directory_name_lower ON ghosts(request_key, directory_name_lower);",
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 3,
            description: "add_updated_at_and_reset_ghosts_cache",
            sql: "ALTER TABLE ghosts ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';\nCREATE INDEX IF NOT EXISTS idx_ghosts_request_key_updated_at ON ghosts(request_key, updated_at);\nDELETE FROM ghosts;",
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 4,
            description: "add_craftman_and_reset_ghosts_cache",
            sql: "ALTER TABLE ghosts ADD COLUMN craftman TEXT NOT NULL DEFAULT '';\nDELETE FROM ghosts;",
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::migrations;
    use rusqlite::Connection;

    // マイグレーション SQL が SQLite で実際に実行できることを検証する。
    // DEFAULT に CURRENT_TIMESTAMP のような関数を使った場合もここで検知できる。
    #[test]
    fn マイグレーションが順番にインメモリdbへ適用できる() {
        let conn = Connection::open_in_memory().unwrap();
        let mut applied = migrations();
        applied.sort_by_key(|m| m.version);
        for m in applied {
            conn.execute_batch(m.sql)
                .unwrap_or_else(|e| panic!("migration {} ({}) failed: {}", m.version, m.description, e));
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:ghosts.db", migrations())
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            commands::ghost::scan_ghosts_with_meta,
            commands::ghost::get_ghosts_fingerprint,
            commands::ssp::launch_ghost,
            commands::ssp::validate_ssp_path,
            commands::locale::read_user_locale,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
