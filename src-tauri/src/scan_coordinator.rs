use std::sync::{Arc, Mutex};

/// `scan_and_store` / `reset_ghost_db` / `record_launch` を直列化する所有ロック。
/// `spawn_blocking` の `'static` クロージャへ move するため `Arc` で包む。
/// 中身は `()`（状態を持たない）ため poison しても `into_inner` で安全に回復できる。
#[derive(Default, Clone)]
pub struct ScanCoordinator(pub Arc<Mutex<()>>);

// #146 Phase2 の段階配線: scan_and_store が Job::Scan（DB アクター）へ移植され、
// 本 struct のメソッドを呼ぶ本番コードは無くなった。struct 自体（.manage 対象）と
// tests/lock_wiring.rs はまだ残っており、ファイルごとの撤去は Task 8 で行う。
#[allow(dead_code)]
impl ScanCoordinator {
    /// poison 回復（`into_inner`）込みでロックを取得する唯一の入口。
    /// 回復ポリシーをここに集約し、呼び出し側でのイディオム再実装を避ける。
    pub(crate) fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// ロック配下で `f` を `spawn_blocking` の別スレッドで実行する（3 コマンド共通の定型）。
    /// ロック待ちは blocking スレッドで起きるため、メインスレッドは固まらない。
    /// `task_name` は join 失敗時のエラーメッセージ用（`map_err` は async 側で走るため借用のままでよい）。
    pub(crate) async fn run_serialized<T: Send + 'static>(
        &self,
        task_name: &str,
        f: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let coordinator = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = coordinator.lock();
            f()
        })
        .await
        .map_err(|e| format!("{task_name}の実行に失敗しました: {e}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::ScanCoordinator;

    #[test]
    fn lock_を取得しpoisonから回復できる() {
        let c = ScanCoordinator::default();
        // 正常取得（本番の回復付き入口 lock() を通す）
        {
            let _g = c.lock();
        }
        // poison させる（ロック保持中に panic）
        let c2 = c.clone();
        let _ = std::panic::catch_unwind(|| {
            let _g = c2.0.lock().unwrap();
            panic!("poison を発生させる");
        });
        // lock() が into_inner で回復して再取得できる
        let _g = c.lock();
    }
}
