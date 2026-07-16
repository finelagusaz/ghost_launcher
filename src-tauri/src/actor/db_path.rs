// ghosts.db のパス解決の単一権威。起動時の bootstrap（sanitize・user-data 初期化・ghosts.db open）
// で参照される。tauri-plugin-sql の "sqlite:ghosts.db"（app_config_dir 基準）と
// 同じディレクトリを参照するための単一権威である。
// app_config_dir と app_data_dir は Windows では同一パスに収束するが、
// それはプラットフォームの偶然であり、別 API での解決を混在させてはならない。
// reset は撤去済み（#146 で削除。DB リビルドは cache_schema::ensure_cache_schema が自動で行う）。
//
// actor モジュール専有（可視性封鎖・設計書 §2.3）。コマンド層から ghosts.db のパス解決はできない。

use tauri::Manager;

/// ghosts.db 本体と WAL/SHM の関連ファイル名
pub(super) const GHOST_DB_FILES: [&str; 3] = ["ghosts.db", "ghosts.db-wal", "ghosts.db-shm"];

/// ghosts.db を格納するディレクトリ（tauri-plugin-sql と同じ app_config_dir 基準）
pub(super) fn ghost_db_dir<R: tauri::Runtime>(
    manager: &impl Manager<R>,
) -> Result<std::path::PathBuf, String> {
    manager
        .path()
        .app_config_dir()
        .map_err(|e| format!("アプリ設定ディレクトリの取得に失敗: {e}"))
}

/// user-data.db（永続ユーザーデータ）本体のフルパス。ghosts.db と同じ app_config_dir 基準。
/// user-data.db は永続ストアであり、sanitize（ghosts.db の破損検査）の削除対象に含めない。
pub(super) fn user_data_db_path<R: tauri::Runtime>(
    manager: &impl Manager<R>,
) -> Result<std::path::PathBuf, String> {
    Ok(ghost_db_dir(manager)?.join("user-data.db"))
}
