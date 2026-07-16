mod actor;
mod commands;
mod scan_coordinator;
mod cache_schema;
#[cfg(test)]
pub(crate) mod testutil;
#[cfg(feature = "bench")]
pub mod bench_support;

// 統合テスト（tests/lock_wiring.rs）から mock_builder で ScanCoordinator を直接駆動するための最小公開。
// scan_and_store は Job::Scan（DB アクター）へ移植され ScanCoordinator を経由しなくなったため、
// scan_and_store 自体の再公開は不要になった（#146 Phase2・lock_wiring.rs の scan テストは削除済み）。
// ScanCoordinator 側の公開・tests/lock_wiring.rs ごとの撤去は Task 8 で行う。
#[doc(hidden)]
pub use scan_coordinator::ScanCoordinator;

// マイグレーション追加時の注意:
//   ALTER TABLE ... ADD COLUMN ... DEFAULT <値> の <値> はリテラルのみ許容される。
//   CURRENT_TIMESTAMP や datetime('now') などの関数は SQLite が拒否する（起動時クラッシュ）。
//   正しい例: DEFAULT ''   誤った例: DEFAULT CURRENT_TIMESTAMP
//   実際の時刻は INSERT 時の VALUES 句で CURRENT_TIMESTAMP を使って設定すること。
// parity テスト専用。スキーマ初変更時に cache_schema のテストごと削除する
// （本番配線では使われない。単一権威は cache_schema::CACHE_SCHEMA）。
#[cfg(test)]
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
        tauri_plugin_sql::Migration {
            version: 8,
            description: "add_sakura_kero_craftmanw_and_reset_ghosts_cache",
            sql: "ALTER TABLE ghosts ADD COLUMN sakura_name TEXT NOT NULL DEFAULT '';\nALTER TABLE ghosts ADD COLUMN kero_name TEXT NOT NULL DEFAULT '';\nALTER TABLE ghosts ADD COLUMN craftmanw TEXT NOT NULL DEFAULT '';\nALTER TABLE ghosts ADD COLUMN sakura_name_lower TEXT NOT NULL DEFAULT '';\nALTER TABLE ghosts ADD COLUMN kero_name_lower TEXT NOT NULL DEFAULT '';\nALTER TABLE ghosts ADD COLUMN craftman_lower TEXT NOT NULL DEFAULT '';\nALTER TABLE ghosts ADD COLUMN craftmanw_lower TEXT NOT NULL DEFAULT '';\nDELETE FROM ghosts;",
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 9,
            description: "create_ghost_fingerprints_table",
            sql: "CREATE TABLE IF NOT EXISTS ghost_fingerprints (\n  request_key TEXT PRIMARY KEY,\n  fingerprint TEXT NOT NULL,\n  updated_at TEXT NOT NULL DEFAULT ''\n);",
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 10,
            description: "add_parent_mtimes_to_ghost_fingerprints",
            sql: "ALTER TABLE ghost_fingerprints ADD COLUMN parent_mtimes TEXT NOT NULL DEFAULT '';",
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 11,
            description: "create_ghost_launches_table",
            sql: "CREATE TABLE IF NOT EXISTS ghost_launches (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  ghost_identity_key TEXT NOT NULL,\n  launched_at TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_ghost_launches_identity ON ghost_launches(ghost_identity_key);\nCREATE INDEX IF NOT EXISTS idx_ghost_launches_at ON ghost_launches(launched_at DESC);",
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 12,
            description: "add_launch_aggregates_to_ghosts",
            sql: "ALTER TABLE ghosts ADD COLUMN last_launched TEXT;\nALTER TABLE ghosts ADD COLUMN launch_count INTEGER NOT NULL DEFAULT 0;",
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 13,
            description: "drop_legacy_ghost_launches_from_cache_db",
            sql: "DROP TABLE IF EXISTS ghost_launches;",
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 14,
            description: "create_ghost_scan_entries_table",
            // 走査差分（delta）用の per-row テーブル。scan_key（生の物理キー）→ token を保持し、
            // Layer 2 ミス時に変更子だけ再 parse するための前回状態を担う。ghost_identity_key は
            // 削除子の ghosts 操作・一意性ガードに使う畳み込みキー。WITHOUT ROWID で
            // (request_key, scan_key, token, ghost_identity_key) を単一 B-tree のカバリング構成にする。
            // 揮発キャッシュ（ghosts と運命共有・request_key で一括削除）。
            sql: "CREATE TABLE IF NOT EXISTS ghost_scan_entries (\n  request_key TEXT NOT NULL,\n  scan_key TEXT NOT NULL,\n  token TEXT NOT NULL,\n  ghost_identity_key TEXT NOT NULL,\n  PRIMARY KEY (request_key, scan_key)\n) WITHOUT ROWID;",
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::migrations;
    use rusqlite::Connection;

    /// version 昇順で migrations() を適用する（parity テスト入力の健全性検査専用のローカルヘルパー）。
    fn apply_migrations_sorted(conn: &Connection) {
        let mut sorted = migrations();
        sorted.sort_by_key(|m| m.version);
        for m in &sorted {
            conn.execute_batch(m.sql).unwrap_or_else(|e| {
                panic!("migration {} ({}) failed: {}", m.version, m.description, e)
            });
        }
    }

    // マイグレーション SQL が SQLite で実際に実行できることを検証する。
    // DEFAULT に CURRENT_TIMESTAMP のような関数を使った場合もここで検知できる。
    #[test]
    fn マイグレーションが順番にインメモリdbへ適用できる() {
        let conn = Connection::open_in_memory().unwrap();
        apply_migrations_sorted(&conn);
    }

    #[test]
    fn migration12と13で集計列追加と旧履歴テーブル除去が行われる() {
        let conn = Connection::open_in_memory().unwrap();
        apply_migrations_sorted(&conn);
        // ghosts に集計列が存在する
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(ghosts)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(cols.contains(&"last_launched".to_string()));
        assert!(cols.contains(&"launch_count".to_string()));
        // 旧 ghost_launches テーブルは ghosts.db から除去されている
        let has_launches: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='ghost_launches'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(has_launches, 0, "ghost_launches は user-data.db へ分離され ghosts.db からは除去される");
    }

    #[test]
    fn ghost_viewの全選択列がghostsスキーマに存在する() {
        // JS 側（ghostDatabase.ts の GHOST_VIEW_COLUMNS）と同じ fixture を参照し、
        // GhostView 型・SELECT 列・SQLite スキーマの三者同期を縛る。
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/test/fixtures/ghost-view-columns.json"
        );
        let raw = std::fs::read_to_string(path).expect("fixture を読めること");
        let expected_columns: Vec<String> = serde_json::from_str(&raw).unwrap();
        assert!(!expected_columns.is_empty(), "fixture が空でないこと");

        let conn = Connection::open_in_memory().unwrap();
        crate::testutil::apply_cache_schema(&conn);
        let schema_columns: Vec<String> = conn
            .prepare("PRAGMA table_info(ghosts)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(Result::ok)
            .collect();

        for column in &expected_columns {
            assert!(
                schema_columns.contains(column),
                "GhostView の選択列 {column} が ghosts テーブルに存在しない（fixture: ghost-view-columns.json）"
            );
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
        // migration 8 も適用できること
        conn.execute_batch(sorted[7].sql)
            .unwrap_or_else(|e| panic!("migration 8 failed: {}", e));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(scan_coordinator::ScanCoordinator::default())
        .setup(|app| {
            match actor::bootstrap(app) {
                Ok(handle) => {
                    app.manage(handle);
                }
                Err(e) => return Err(format!("DB アクターの起動に失敗しました: {e}").into()),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ghost::scan_and_store,
            commands::launch_history::record_launch,
            commands::ssp::launch_ghost,
            commands::ssp::validate_ssp_path,
            commands::locale::read_user_locale,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
