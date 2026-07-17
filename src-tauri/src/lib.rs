mod actor;
mod commands;
mod cache_schema;
#[cfg(test)]
pub(crate) mod testutil;
#[cfg(feature = "bench")]
pub mod bench_support;

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

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

}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
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
            commands::ghost::cleanup_ghost_caches,
            commands::launch_history::record_launch,
            commands::ssp::launch_ghost,
            commands::ssp::validate_ssp_path,
            commands::locale::read_user_locale,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
