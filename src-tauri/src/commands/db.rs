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
    let lock = coordinator.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        let db_dir = db_path::ghost_db_dir(&app_handle)?;
        for filename in db_path::GHOST_DB_FILES {
            let path = db_dir.join(filename);
            if path.exists() {
                std::fs::remove_file(&path).map_err(|e| format!("{filename} の削除に失敗: {e}"))?;
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("DB リセットタスクの実行に失敗しました: {e}"))?
}

// lock 配線の回帰ガードは統合テスト（tests/lock_wiring.rs）に置く。
// mock_builder が要求する common-controls v6 マニフェストは build.rs の rustc-link-arg-tests で
// 統合テストバイナリにのみ埋め込めるため（lib ユニットテストハーネスにはスコープが届かない）。
