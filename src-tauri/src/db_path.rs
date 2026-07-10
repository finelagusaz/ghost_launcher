// ghosts.db パス解決の単一権威。
// tauri-plugin-sql は "sqlite:ghosts.db" を app_config_dir 基準で解決するため、
// 書込（scan_and_store）・削除（reset_ghost_db）・起動時検査（sanitize_ghost_db）も
// 必ずここを経由して同じディレクトリを参照する。
// app_config_dir と app_data_dir は Windows では同一パスに収束するが、
// それはプラットフォームの偶然であり、別 API での解決を混在させてはならない。

use tauri::Manager;

/// ghosts.db 本体と WAL/SHM の関連ファイル名
pub(crate) const GHOST_DB_FILES: [&str; 3] = ["ghosts.db", "ghosts.db-wal", "ghosts.db-shm"];

/// ghosts.db を格納するディレクトリ（tauri-plugin-sql と同じ app_config_dir 基準）
pub(crate) fn ghost_db_dir<R: tauri::Runtime>(
    manager: &impl Manager<R>,
) -> Result<std::path::PathBuf, String> {
    manager
        .path()
        .app_config_dir()
        .map_err(|e| format!("アプリ設定ディレクトリの取得に失敗: {e}"))
}

/// ghosts.db 本体のフルパス
pub(crate) fn ghost_db_path<R: tauri::Runtime>(
    manager: &impl Manager<R>,
) -> Result<std::path::PathBuf, String> {
    Ok(ghost_db_dir(manager)?.join(GHOST_DB_FILES[0]))
}

/// user-data.db（永続ユーザーデータ）本体のフルパス。ghosts.db と同じ app_config_dir 基準。
/// user-data.db は永続ストアであり、reset_ghost_db / sanitize_ghost_db の削除対象に含めない。
pub(crate) fn user_data_db_path<R: tauri::Runtime>(
    manager: &impl Manager<R>,
) -> Result<std::path::PathBuf, String> {
    Ok(ghost_db_dir(manager)?.join("user-data.db"))
}
