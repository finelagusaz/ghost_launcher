use tauri::Manager;

/// ghosts.db と関連ファイル（WAL/SHM）を削除してマイグレーション競合を解消する
#[tauri::command]
pub fn reset_ghost_db(app_handle: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("アプリデータディレクトリの取得に失敗: {e}"))?;

    for filename in ["ghosts.db", "ghosts.db-wal", "ghosts.db-shm"] {
        let path = app_data_dir.join(filename);
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("{filename} の削除に失敗: {e}"))?;
        }
    }
    Ok(())
}
