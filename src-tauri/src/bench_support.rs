//! 10万体規模の性能計測用フィクスチャ生成器と本番経路ラッパー。
//! `bench` feature 有効時のみコンパイルされ、本番ビルドには含まれない。

use std::path::Path;

use rusqlite::Connection;

use crate::commands::ghost::store::{configure_connection, store_ghosts};
use crate::commands::ghost::Ghost;

/// クレートルートから内部経路へ到達できることを確認するプレースホルダ。
/// 後続タスクで seeder / generator / wrapper に置き換える。
#[doc(hidden)]
pub fn __bench_support_linked() -> bool {
    true
}

/// どの行にもマッチしない語（0 件）
pub const Q_NONE: &str = "該当なし_zzzq";
/// 約 0.1% にマッチ（craftman が "作者777" の行 = i % 1000 == 777）
pub const Q_RARE: &str = "作者777";
/// 約 10% にマッチ（name が "さくら…" の行 = i % 10 == 0）
pub const Q_COMMON: &str = "さくら";

/// 本番読み取り接続（loadDb, ghostDatabase.ts）と同じ PRAGMA で一時 DB を開く。
/// ghosts テーブルが未作成のときだけ migrations を適用する（同一ファイルへの
/// 二度目の open で ALTER TABLE ADD COLUMN が "duplicate column" で落ちるのを防ぐ）。
/// 書き込み用 configure_connection の大 cache は引かない。
pub fn open_bench_db(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("DB open: {e}"))?;
    let has_schema: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='ghosts'",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !has_schema {
        let mut ms = crate::migrations();
        ms.sort_by_key(|m| m.version);
        for m in &ms {
            conn.execute_batch(m.sql)
                .map_err(|e| format!("migration {}: {e}", m.version))?;
        }
    }
    // 本番読み取り接続の PRAGMA（loadDb と同順）。大 cache/mmap は意図的に引かない。
    // データ投入後の再 open では optimize=0x10002 の ANALYZE が本番同様に統計を作る。
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;\
         PRAGMA busy_timeout=5000;\
         PRAGMA journal_size_limit=4194304;\
         PRAGMA optimize=0x10002;",
    )
    .map_err(|e| format!("PRAGMA: {e}"))?;
    Ok(conn)
}

/// 現実寄せ分布の合成ゴースト 1 件を生成する（決定的・index ベース）。
fn synth_ghost(i: usize) -> Ghost {
    let jp = ["さくら", "うにゅう", "ゴースト", "妖精", "式神"];
    let en = ["Alice", "Bob", "Ghost", "Fairy", "Nova"];
    // i % 10 == 0 の行だけ名前を "さくら…" にして Q_COMMON の選択率を ~10% に固定
    let base = if i % 10 == 0 {
        "さくら"
    } else if i % 2 == 0 {
        jp[i % jp.len()]
    } else {
        en[i % en.len()]
    };
    Ghost {
        diff_fingerprint: format!("fp-{i}"),
        name: format!("{base}{i}"),
        sakura_name: if i % 3 == 0 { format!("{base}の精") } else { String::new() },
        kero_name: if i % 5 == 0 { format!("相方{i}") } else { String::new() },
        // i % 1000 == 777 の行だけ craftman が "作者777" → Q_RARE の選択率 ~0.1%
        craftman: format!("作者{}", i % 1000),
        craftmanw: String::new(),
        directory_name: format!("dir_{i:06}"),
        path: format!("C:/ghosts/dir_{i:06}"),
        source: "ssp".to_string(),
        thumbnail_path: String::new(),
        thumbnail_use_self_alpha: false,
        thumbnail_kind: String::new(),
    }
}

/// N 行を本番の store_ghosts 経由で投入し、起動集計列を一部にばらけさせる。
pub fn seed_ghosts_db(conn: &Connection, request_key: &str, n: usize) -> Result<(), String> {
    configure_connection(conn)?; // 書き込みは本番と同じ PRAGMA で高速化（読み取り計測とは別接続想定）
    let ghosts: Vec<Ghost> = (0..n).map(synth_ghost).collect();
    store_ghosts(conn, request_key, &ghosts, "bench-fp", "bench-mtimes")?;

    // recent/frequency ソートの現実性: 25% に last_launched、一部に launch_count を付与
    conn.execute(
        "UPDATE ghosts SET \
           last_launched = datetime('now', '-' || (id % 30) || ' days'), \
           launch_count = (id % 7) \
         WHERE request_key = ?1 AND id % 4 = 0",
        [request_key],
    )
    .map_err(|e| format!("sprinkle: {e}"))?;
    Ok(())
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

    use crate::testutil::TempDirGuard;

    #[test]
    fn seed_ghosts_db_が_n_行を投入する() {
        let tmp = TempDirGuard::new("bench_seed_count");
        let db = tmp.path().join("ghosts.db");
        let conn = open_bench_db(&db).unwrap();
        seed_ghosts_db(&conn, "rk", 500).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ghosts WHERE request_key = ?1",
                ["rk"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 500);
    }

    #[test]
    fn seed_ghosts_db_が_lower_列を正規化する() {
        let tmp = TempDirGuard::new("bench_seed_lower");
        let db = tmp.path().join("ghosts.db");
        let conn = open_bench_db(&db).unwrap();
        seed_ghosts_db(&conn, "rk", 50).unwrap();

        // name_lower は全て小文字（NFKC + lower 済み）
        let bad: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ghosts WHERE request_key='rk' AND name_lower != lower(name_lower)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(bad, 0);
    }

    #[test]
    fn seed_ghosts_db_が起動集計列をばらけさせる() {
        let tmp = TempDirGuard::new("bench_seed_launch");
        let db = tmp.path().join("ghosts.db");
        let conn = open_bench_db(&db).unwrap();
        seed_ghosts_db(&conn, "rk", 400).unwrap();

        let launched: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ghosts WHERE request_key='rk' AND last_launched IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // 一部のみ非 NULL（全 NULL でも全非 NULL でもない）
        assert!(launched > 0 && launched < 400);
    }

    #[test]
    fn クエリセットの選択率が意図の桁に収まる() {
        let tmp = TempDirGuard::new("bench_seed_selectivity");
        let db = tmp.path().join("ghosts.db");
        let conn = open_bench_db(&db).unwrap();
        seed_ghosts_db(&conn, "rk", 10_000).unwrap();

        let count = |q: &str| -> i64 {
            let like = format!("%{}%", q);
            conn.query_row(
                "SELECT COUNT(*) FROM ghosts WHERE request_key='rk' AND \
                 (name_lower LIKE ?1 OR sakura_name_lower LIKE ?1 OR kero_name_lower LIKE ?1 \
                  OR craftman_lower LIKE ?1 OR craftmanw_lower LIKE ?1 OR directory_name_lower LIKE ?1)",
                [like],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(count(Q_NONE), 0);
        assert!(count(Q_RARE) > 0 && count(Q_RARE) < 100); // ~0.1% = ~10
        assert!(count(Q_COMMON) > 500); // ~10% = ~1000
    }
}
