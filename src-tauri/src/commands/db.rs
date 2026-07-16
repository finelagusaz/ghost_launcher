use crate::db_path;

/// ghosts.db と関連ファイル（WAL/SHM）を削除してマイグレーション競合を解消する。
/// scan と同じ ScanCoordinator ロックを取り、走査中の削除（DB open/write 失敗）を防ぐ。
/// 別スレッド実行のためメインスレッドはロック待ちで固まらない。
#[tauri::command]
pub async fn reset_ghost_db(
    app_handle: tauri::AppHandle,
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

#[cfg(test)]
mod tests {
    use crate::scan_coordinator::ScanCoordinator;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn 同一ロックがresetとscanを相互排他する() {
        let coord = ScanCoordinator::default();
        let held = Arc::new(AtomicBool::new(false));
        let overlap = Arc::new(AtomicBool::new(false));
        let barrier = Arc::new(Barrier::new(2));

        // scan 役: ロックを保持している間フラグを立てる。
        let c1 = coord.clone();
        let held1 = held.clone();
        let b1 = barrier.clone();
        let scan = thread::spawn(move || {
            b1.wait();
            let _g = c1.0.lock().unwrap_or_else(|e| e.into_inner());
            held1.store(true, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(50));
            held1.store(false, Ordering::SeqCst);
        });

        // reset 役: ロック取得時に scan がロック保持中でないことを確認する。
        let c2 = coord.clone();
        let held2 = held.clone();
        let overlap2 = overlap.clone();
        let b2 = barrier.clone();
        let reset = thread::spawn(move || {
            b2.wait();
            thread::sleep(Duration::from_millis(10)); // scan に先にロックを取らせる
            let _g = c2.0.lock().unwrap_or_else(|e| e.into_inner());
            if held2.load(Ordering::SeqCst) {
                overlap2.store(true, Ordering::SeqCst);
            }
        });

        scan.join().unwrap();
        reset.join().unwrap();
        assert!(!overlap.load(Ordering::SeqCst), "reset と scan が同時にロックを保持してはならない");
    }
}
