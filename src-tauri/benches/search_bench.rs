//! SQL 層(search/sort/OFFSET)の計測。cargo bench --features bench --bench search_bench

use std::time::Duration;

use criterion::{BenchmarkId, Criterion};
use ghost_launcher_lib::bench_support::{
    open_bench_db, order_by, search_where_prefixed, seed_ghosts_db, select_cols_prefixed,
    Q_COMMON, Q_NONE, Q_RARE,
};
use rusqlite::Connection;

const RK: &str = "bench-rk";
const LIMIT: i64 = 50;

/// seed 済み一時 DB を本番読み取り PRAGMA で開き直して返す（seed 接続の書き込み PRAGMA を継がない）。
/// tag は N ごとに一意化してディレクトリ名衝突を避ける。
fn seeded_readonly_db(tag: &str, n: usize) -> (tempfile_dir::Guard, Connection) {
    let guard = tempfile_dir::Guard::new(tag);
    let path = guard.path().join("ghosts.db");
    {
        let seed_conn = open_bench_db(&path).unwrap();
        seed_ghosts_db(&seed_conn, RK, n).unwrap();
    } // seed 接続を閉じる
    let read_conn = open_bench_db(&path).unwrap(); // 読み取り PRAGMA で開き直す
    (guard, read_conn)
}

/// rusqlite の異種パラメータ配列問題を避けるため Params ジェネリックにする。
/// 呼び出し側は rusqlite::params![..] を渡す。
fn run_select<P: rusqlite::Params>(conn: &Connection, sql: &str, params: P) -> usize {
    let mut stmt = conn.prepare_cached(sql).unwrap();
    stmt.query_map(params, |_r| Ok(()))
        .unwrap()
        .filter_map(|r| r.ok())
        .count()
}

fn dump_query_plans() {
    let (_g, conn) = seeded_readonly_db("plan", 1000);
    // 本番 GHOST_SELECT_COLUMNS_PREFIXED と同形の投影（fixture 連動・materialize コストを再現）
    let select_cols = select_cols_prefixed();
    let where_c = search_where_prefixed();
    // EXPLAIN QUERY PLAN は未束縛 ? を嫌うため、リテラル値で組む（プランは値非依存で SCAN/index が判る）。
    let where_lit = where_c.replace("LIKE ?", "LIKE '%さくら%'");
    let shapes: Vec<(&str, String)> = vec![
        ("empty+name", format!("SELECT {select_cols} FROM ghosts g WHERE g.request_key='{RK}' ORDER BY {} LIMIT 50", order_by("name"))),
        ("like+name", format!("SELECT {select_cols} FROM ghosts g WHERE g.request_key='{RK}' AND ({where_lit}) ORDER BY {} LIMIT 50", order_by("name"))),
        ("empty+recent", format!("SELECT {select_cols} FROM ghosts g WHERE g.request_key='{RK}' ORDER BY {} LIMIT 50", order_by("recent"))),
        ("empty+frequency", format!("SELECT {select_cols} FROM ghosts g WHERE g.request_key='{RK}' ORDER BY {} LIMIT 50", order_by("frequency"))),
        ("empty+random", format!("SELECT {select_cols} FROM ghosts g WHERE g.request_key='{RK}' ORDER BY {} LIMIT 50", order_by("random"))),
    ];
    println!("\n===== EXPLAIN QUERY PLAN (n=1000) =====");
    for (label, sql) in shapes {
        println!("--- {label} ---");
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        // EXPLAIN QUERY PLAN の detail 列は index 3
        let mut rows = stmt.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            let detail: String = row.get(3).unwrap();
            println!("  {detail}");
        }
    }
    println!("=======================================\n");
}

fn bench_search(c: &mut Criterion) {
    // 本番 GHOST_SELECT_COLUMNS_PREFIXED と同形の投影（fixture 連動・materialize コストを再現）
    let select_cols = select_cols_prefixed();
    let where_c = search_where_prefixed();
    // COUNT は本番 countGhostsByQuery と同形（前置きなし 6 列 OR）
    let count_where = where_c.replace("g.", "");
    for &n in &[1_000usize, 10_000, 100_000] {
        let (_g, conn) = seeded_readonly_db(&format!("n{n}"), n);
        let like_none = format!("%{Q_NONE}%");
        let like_rare = format!("%{Q_RARE}%");
        let like_common = format!("%{Q_COMMON}%");

        let mut group = c.benchmark_group(format!("search_n{n}"));
        if n >= 100_000 {
            group.sample_size(20).measurement_time(Duration::from_secs(15));
        }

        // 空クエリ × 各ソート（無名 ? 統一。params: [rk, limit]）
        for sort in ["name", "recent", "frequency", "random"] {
            let sql = format!(
                "SELECT {select_cols} FROM ghosts g WHERE g.request_key=? ORDER BY {} LIMIT ?",
                order_by(sort)
            );
            group.bench_with_input(BenchmarkId::new("empty_sort", sort), &sql, |b, sql| {
                b.iter(|| run_select(&conn, sql, rusqlite::params![RK, LIMIT]));
            });
        }

        // LIKE 選択率 3 種（sort=name 固定。params: [rk, like×6, limit]）
        for (label, like) in [("none", &like_none), ("rare", &like_rare), ("common", &like_common)] {
            let sql = format!(
                "SELECT {select_cols} FROM ghosts g WHERE g.request_key=? AND ({where_c}) \
                 ORDER BY {} LIMIT ?",
                order_by("name")
            );
            group.bench_with_input(BenchmarkId::new("like", label), &sql, |b, sql| {
                b.iter(|| {
                    run_select(
                        &conn,
                        sql,
                        rusqlite::params![RK, like, like, like, like, like, like, LIMIT],
                    )
                });
            });
        }

        // OFFSET 深度（空クエリ・sort=name。params: [rk, limit, offset]）
        for (label, offset) in [("0", 0i64), ("mid", (n as i64) / 2), ("deep", (n as i64 - LIMIT).max(0))] {
            let sql = format!(
                "SELECT {select_cols} FROM ghosts g WHERE g.request_key=? ORDER BY {} LIMIT ? OFFSET ?",
                order_by("name")
            );
            group.bench_with_input(BenchmarkId::new("offset", label), &offset, |b, &offset| {
                b.iter(|| run_select(&conn, &sql, rusqlite::params![RK, LIMIT, offset]));
            });
        }

        // COUNT + SELECT 併走（本番 1 検索の実コスト・common クエリ）
        // count は前置きなし 6 列 OR（本番 countGhostsByQuery）、params: [rk, like×6]
        let count_sql = format!(
            "SELECT COUNT(*) FROM ghosts WHERE request_key=? AND ({count_where})"
        );
        // select は g. 前置き（本番 searchGhosts）、params: [rk, like×6, limit]
        let select_sql = format!(
            "SELECT {select_cols} FROM ghosts g WHERE g.request_key=? AND ({where_c}) \
             ORDER BY {} LIMIT ?",
            order_by("name")
        );
        group.bench_function("count_plus_select_common", |b| {
            b.iter(|| {
                let lc = &like_common;
                let _c: i64 = conn
                    .query_row(&count_sql, rusqlite::params![RK, lc, lc, lc, lc, lc, lc], |r| r.get(0))
                    .unwrap();
                run_select(
                    &conn,
                    &select_sql,
                    rusqlite::params![RK, lc, lc, lc, lc, lc, lc, LIMIT],
                );
            });
        });

        group.finish();
    }
}

// TempDirGuard は lib 内部（非 pub）なので、ベンチ用の最小 tmp ガードをローカルに持つ。
mod tempfile_dir {
    use std::path::{Path, PathBuf};
    pub struct Guard(PathBuf);
    impl Guard {
        pub fn new(prefix: &str) -> Self {
            // scratchpad ではなく OS 一時ディレクトリ配下。ベンチ終了時に削除。
            let mut base = std::env::temp_dir();
            base.push(format!("ghost_bench_{prefix}_{}", std::process::id()));
            std::fs::create_dir_all(&base).unwrap();
            Guard(base)
        }
        pub fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Guard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

fn main() {
    dump_query_plans();
    let mut c = Criterion::default().configure_from_args();
    bench_search(&mut c);
    c.final_summary();
}
