use crate::db_path;

/// ghosts.db と関連ファイル（WAL/SHM）を削除してマイグレーション競合を解消する
#[tauri::command]
pub fn reset_ghost_db(app_handle: tauri::AppHandle) -> Result<(), String> {
    let db_dir = db_path::ghost_db_dir(&app_handle)?;

    for filename in db_path::GHOST_DB_FILES {
        let path = db_dir.join(filename);
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("{filename} の削除に失敗: {e}"))?;
        }
    }
    Ok(())
}
