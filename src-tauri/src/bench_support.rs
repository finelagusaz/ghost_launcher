//! 10万体規模の性能計測用フィクスチャ生成器と本番経路ラッパー。
//! `bench` feature 有効時のみコンパイルされ、本番ビルドには含まれない。

use rusqlite::Connection;

/// クレートルートから内部経路へ到達できることを確認するプレースホルダ。
/// 後続タスクで seeder / generator / wrapper に置き換える。
#[doc(hidden)]
pub fn __bench_support_linked() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bench_support_がリンクされる() {
        assert!(__bench_support_linked());
    }

    #[test]
    fn 内部型と関数へ到達できる() {
        // 再エクスポート4種すべての疎通確認（import できてコンパイルが通れば可視性は正しい）。
        // 注: この use は #[cfg(test)] 配下のため、feature 有効の非テストビルドでは
        // 再エクスポートに消費者がなく unused 警告が出る（Task 6 が bench_support 関数で
        // scan/fingerprint を消費した時点で解消。CI は --features bench をビルドしないため無害）。
        use crate::commands::ghost::{
            check_parent_mtimes_match, collect_parent_mtimes,
            scan_ghosts_with_fingerprint_internal, Ghost,
        };
        let _ = std::mem::size_of::<Ghost>();
        let _ = collect_parent_mtimes as fn(&str, &[String]) -> String;
        let _ = check_parent_mtimes_match as fn(&Connection, &str, &str) -> bool;
        let _ = scan_ghosts_with_fingerprint_internal
            as fn(&str, &[String]) -> Result<(Vec<Ghost>, String), String>;
    }
}
