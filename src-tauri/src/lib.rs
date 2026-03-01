mod commands;

use tauri::Manager;

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
        tauri_plugin_sql::Migration {
            version: 5,
            description: "add_thumbnail_and_reset_ghosts_cache",
            sql: "ALTER TABLE ghosts ADD COLUMN thumbnail_path TEXT NOT NULL DEFAULT '';\nALTER TABLE ghosts ADD COLUMN thumbnail_use_self_alpha INTEGER NOT NULL DEFAULT 0;\nDELETE FROM ghosts;",
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 6,
            description: "add_thumbnail_kind_and_reset_ghosts_cache",
            sql: "ALTER TABLE ghosts ADD COLUMN thumbnail_kind TEXT NOT NULL DEFAULT '';\nDELETE FROM ghosts;",
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 7,
            description: "add_ghost_identity_and_row_fingerprint",
            sql: "ALTER TABLE ghosts ADD COLUMN ghost_identity_key TEXT NOT NULL DEFAULT '';\nALTER TABLE ghosts ADD COLUMN row_fingerprint TEXT NOT NULL DEFAULT '';\nDELETE FROM ghosts;\nCREATE UNIQUE INDEX IF NOT EXISTS idx_ghosts_request_key_identity ON ghosts(request_key, ghost_identity_key);\nCREATE INDEX IF NOT EXISTS idx_ghosts_request_key_identity_fingerprint ON ghosts(request_key, ghost_identity_key, row_fingerprint);",
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::{has_migration_conflict, migrations};
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

    #[test]
    fn マイグレーション7は既存の同一request_key行があっても適用できる() {
        // DELETE が CREATE UNIQUE INDEX より先に実行されることを確認するリグレッションテスト。
        // 修正前は同一 request_key の複数行が全て ghost_identity_key='' となり
        // UNIQUE INDEX 作成時に制約違反で失敗していた。
        let conn = Connection::open_in_memory().unwrap();
        let mut sorted = migrations();
        sorted.sort_by_key(|m| m.version);
        // migration 1-6 を適用
        for m in sorted.iter().take(6) {
            conn.execute_batch(m.sql).unwrap();
        }
        // 同一 request_key で複数行挿入（実際のユーザー環境を模擬）
        conn.execute_batch(
            "INSERT INTO ghosts \
             (name, directory_name, path, source, name_lower, directory_name_lower, \
              request_key, updated_at, craftman, thumbnail_path, thumbnail_use_self_alpha, thumbnail_kind) \
             VALUES ('A', 'a', '/a', 'ssp', 'a', 'a', 'rk1', '', '', '', 0, ''), \
                    ('B', 'b', '/b', 'ssp', 'b', 'b', 'rk1', '', '', '', 0, '')",
        )
        .unwrap();
        // migration 7 を適用（以前はここで UNIQUE 制約違反が発生していた）
        conn.execute_batch(sorted[6].sql)
            .unwrap_or_else(|e| panic!("migration 7 failed: {}", e));
    }

    #[test]
    fn 全マイグレーション適用済みなら競合なし() {
        let conn = Connection::open_in_memory().unwrap();
        // _sqlx_migrations テーブルを作成し全バージョンを登録
        conn.execute_batch(
            "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY);",
        )
        .unwrap();
        for m in migrations() {
            conn.execute_batch(m.sql).unwrap();
            conn.execute(
                "INSERT INTO _sqlx_migrations (version) VALUES (?1)",
                [m.version as i64],
            )
            .unwrap();
        }
        assert!(!has_migration_conflict(&conn));
    }

    #[test]
    fn 未適用マイグレーションのカラムが既に存在すれば競合検出() {
        let conn = Connection::open_in_memory().unwrap();
        // migration 1-3 を適用し記録
        conn.execute_batch(
            "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY);",
        )
        .unwrap();
        let mut sorted = migrations();
        sorted.sort_by_key(|m| m.version);
        for m in sorted.iter().take(3) {
            conn.execute_batch(m.sql).unwrap();
            conn.execute(
                "INSERT INTO _sqlx_migrations (version) VALUES (?1)",
                [m.version as i64],
            )
            .unwrap();
        }
        // migration 4 の内容（craftman）をマイグレーション外で追加
        conn.execute_batch("ALTER TABLE ghosts ADD COLUMN craftman TEXT NOT NULL DEFAULT ''")
            .unwrap();
        assert!(has_migration_conflict(&conn));
    }

    #[test]
    fn 未適用マイグレーションのカラムが存在しなければ競合なし() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY);",
        )
        .unwrap();
        let mut sorted = migrations();
        sorted.sort_by_key(|m| m.version);
        for m in sorted.iter().take(3) {
            conn.execute_batch(m.sql).unwrap();
            conn.execute(
                "INSERT INTO _sqlx_migrations (version) VALUES (?1)",
                [m.version as i64],
            )
            .unwrap();
        }
        // craftman を追加せず、migration 4 が未適用 → カラムがないので競合なし
        assert!(!has_migration_conflict(&conn));
    }
}

/// マイグレーション適用前に ghosts.db の整合性を検証する。
/// 未適用マイグレーションが ADD COLUMN しようとするカラムが既に存在する場合、
/// DB ファイルを削除して再作成を促す。ghosts.db はキャッシュなので安全。
fn sanitize_ghost_db(app: &tauri::App) {
    let Ok(app_data_dir) = app.path().app_data_dir() else {
        return;
    };
    let db_path = app_data_dir.join("ghosts.db");
    if !db_path.exists() {
        return;
    }

    let should_delete = match rusqlite::Connection::open(&db_path) {
        Ok(conn) => has_migration_conflict(&conn),
        Err(_) => true, // DB を開けない場合は削除して再作成
    };

    if should_delete {
        for filename in ["ghosts.db", "ghosts.db-wal", "ghosts.db-shm"] {
            let _ = std::fs::remove_file(app_data_dir.join(filename));
        }
    }
}

/// 未適用マイグレーションの ADD COLUMN が既存カラムと競合するか判定する。
fn has_migration_conflict(conn: &rusqlite::Connection) -> bool {
    let max_version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let pending: Vec<_> = migrations()
        .into_iter()
        .filter(|m| m.version as i64 > max_version)
        .collect();
    if pending.is_empty() {
        return false;
    }

    let columns: Vec<String> = conn
        .prepare("PRAGMA table_info(ghosts)")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| row.get::<_, String>(1))
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();
    if columns.is_empty() {
        return false;
    }

    // 未適用マイグレーションが追加しようとするカラムが既に存在するか
    for m in &pending {
        for fragment in m.sql.split("ADD COLUMN ").skip(1) {
            if let Some(col_name) = fragment.split_whitespace().next() {
                if columns.iter().any(|c| c == col_name) {
                    return true;
                }
            }
        }
    }
    false
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
        .setup(|app| {
            sanitize_ghost_db(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::db::reset_ghost_db,
            commands::ghost::scan_ghosts_with_meta,
            commands::ghost::get_ghosts_fingerprint,
            commands::ssp::launch_ghost,
            commands::ssp::validate_ssp_path,
            commands::locale::read_user_locale,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
