use std::sync::{Arc, Mutex};

/// `scan_and_store` / `reset_ghost_db` / `record_launch` を直列化する所有ロック。
/// `spawn_blocking` の `'static` クロージャへ move するため `Arc` で包む。
/// 中身は `()`（状態を持たない）ため poison しても `into_inner` で安全に回復できる。
#[derive(Default, Clone)]
pub struct ScanCoordinator(pub Arc<Mutex<()>>);

impl ScanCoordinator {
    /// ロック配下で `f` を `spawn_blocking` の別スレッドで実行する（3 コマンド共通の定型）。
    /// ロック待ちは blocking スレッドで起きるため、メインスレッドは固まらない。
    /// poison は `into_inner` で回復する。`task_name` は join 失敗時のエラーメッセージ用。
    pub(crate) async fn run_serialized<T: Send + 'static>(
        &self,
        task_name: &str,
        f: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let lock = self.0.clone();
        let name = task_name.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
            f()
        })
        .await
        .map_err(|e| format!("{name}の実行に失敗しました: {e}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::ScanCoordinator;

    #[test]
    fn lock_を取得しpoisonから回復できる() {
        let c = ScanCoordinator::default();
        // 正常取得
        {
            let _g = c.0.lock().unwrap();
        }
        // poison させる（ロック保持中に panic）
        let c2 = c.clone();
        let _ = std::panic::catch_unwind(|| {
            let _g = c2.0.lock().unwrap();
            panic!("poison を発生させる");
        });
        // into_inner で回復して再取得できる
        let _g = c.0.lock().unwrap_or_else(|e| e.into_inner());
    }
}
