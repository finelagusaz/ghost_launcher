use crate::db_path;

/// ghosts.db と関連ファイル（WAL/SHM）を削除してマイグレーション競合を解消する。
/// scan と同じ ScanCoordinator ロックを取り、走査中の削除（DB open/write 失敗）を防ぐ。
/// 別スレッド実行のためメインスレッドはロック待ちで固まらない。
/// `<R>` はテストで `MockRuntime` を渡せるようにするためのランタイム総称化（本番は `Wry` に推論）。
#[tauri::command]
pub async fn reset_ghost_db<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    coordinator: tauri::State<'_, crate::scan_coordinator::ScanCoordinator>,
) -> Result<(), String> {
    coordinator
        .run_serialized("DB リセットタスク", move || {
            let db_dir = db_path::ghost_db_dir(&app_handle)?;
            for filename in db_path::GHOST_DB_FILES {
                let path = db_dir.join(filename);
                if path.exists() {
                    std::fs::remove_file(&path)
                        .map_err(|e| format!("{filename} の削除に失敗: {e}"))?;
                }
            }
            Ok(())
        })
        .await
}

// lock 配線の回帰ガードは tests/lock_wiring.rs（統合テストに置く理由も同ファイル冒頭を参照）。
