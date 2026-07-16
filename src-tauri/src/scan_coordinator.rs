use std::sync::{Arc, Mutex};

/// `scan_and_store` / `reset_ghost_db` を直列化する所有ロック。
/// `spawn_blocking` の `'static` クロージャへ move するため `Arc` で包む。
/// 中身は `()`（状態を持たない）ため poison しても `into_inner` で安全に回復できる。
#[derive(Default, Clone)]
pub struct ScanCoordinator(
    #[allow(dead_code)]
    pub Arc<Mutex<()>>,
);

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
