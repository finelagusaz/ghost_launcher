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

/// 候補検索形状の DDL（#135・LIKE 維持での改善候補）。本番 CACHE_SCHEMA は不変のまま、
/// bench の一時 DB にだけ当てて比較する。search_text は検索 6 列を \x1f（char(31)、
/// ユーザーが入力し得ない区切り）で連結した派生列。_lower 列は全て NOT NULL のため COALESCE 不要。
const CANDIDATE_DDL: &str = "\
ALTER TABLE ghosts ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
UPDATE ghosts SET search_text = name_lower || char(31) || sakura_name_lower || char(31) || kero_name_lower || char(31) || craftman_lower || char(31) || craftmanw_lower || char(31) || directory_name_lower;
CREATE INDEX idx_cand_search_cover ON ghosts(request_key, name_lower, search_text);
CREATE INDEX idx_cand_recent ON ghosts(request_key, last_launched DESC, name_lower);";

/// seed 済み一時 DB に候補 DDL を適用し、読み取り PRAGMA で開き直して返す。
fn seeded_candidate_db(tag: &str, n: usize) -> (tempfile_dir::Guard, Connection) {
    let guard = tempfile_dir::Guard::new(tag);
    let path = guard.path().join("ghosts.db");
    {
        let seed_conn = open_bench_db(&path).unwrap();
        seed_ghosts_db(&seed_conn, RK, n).unwrap();
        seed_conn.execute_batch(CANDIDATE_DDL).unwrap();
    } // seed 接続を閉じる
    let read_conn = open_bench_db(&path).unwrap();
    (guard, read_conn)
}

fn dump_candidate_plans() {
    let (_g, conn) = seeded_candidate_db("cand_plan", 1000);
    let select_cols = select_cols_prefixed();
    let ob = order_by("name");
    let shapes: Vec<(&str, String)> = vec![
        ("like1_concat", format!(
            "SELECT {select_cols} FROM ghosts g WHERE g.request_key='{RK}' AND g.search_text LIKE '%さくら%' ORDER BY {ob} LIMIT 50")),
        ("instr1_concat", format!(
            "SELECT {select_cols} FROM ghosts g WHERE g.request_key='{RK}' AND instr(g.search_text, 'さくら') > 0 ORDER BY {ob} LIMIT 50")),
        ("instr1_cover_subq", format!(
            "SELECT {select_cols} FROM ghosts g WHERE g.id IN (SELECT id FROM ghosts WHERE request_key='{RK}' AND instr(search_text, 'さくら') > 0 ORDER BY name_lower LIMIT 50) ORDER BY {ob}")),
    ];
    println!("\n===== EXPLAIN QUERY PLAN 候補形状 (n=1000) =====");
    for (label, sql) in shapes {
        println!("--- {label} ---");
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let mut rows = stmt.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            let detail: String = row.get(3).unwrap();
            println!("  {detail}");
        }
    }
    println!("===============================================\n");
}

/// 分離測定: 連結列のみ（index なし）。CANDIDATE_DDL との差分がカバリング index の寄与になる。
const CANDIDATE_DDL_NOIDX: &str = "\
ALTER TABLE ghosts ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
UPDATE ghosts SET search_text = name_lower || char(31) || sakura_name_lower || char(31) || kero_name_lower || char(31) || craftman_lower || char(31) || craftmanw_lower || char(31) || directory_name_lower;";

fn seeded_candidate_noidx_db(tag: &str, n: usize) -> (tempfile_dir::Guard, Connection) {
    let guard = tempfile_dir::Guard::new(tag);
    let path = guard.path().join("ghosts.db");
    {
        let seed_conn = open_bench_db(&path).unwrap();
        seed_ghosts_db(&seed_conn, RK, n).unwrap();
        seed_conn.execute_batch(CANDIDATE_DDL_NOIDX).unwrap();
    }
    let read_conn = open_bench_db(&path).unwrap();
    (guard, read_conn)
}

/// 連結列のみ（index なし）の instr 形状。index の寄与を分離する対照実験。
fn bench_candidate_noidx(c: &mut Criterion) {
    let select_cols = select_cols_prefixed();
    let ob = order_by("name");
    for &n in &[100_000usize] {
        let (_g, conn) = seeded_candidate_noidx_db(&format!("cand_noidx_n{n}"), n);
        // 形状の plan も出力する（idx_cand_search_cover 不在の確認）
        let probe = format!(
            "SELECT {select_cols} FROM ghosts g WHERE g.request_key='{RK}' AND instr(g.search_text, 'さくら') > 0 ORDER BY {ob} LIMIT 50"
        );
        println!("\n===== EXPLAIN QUERY PLAN instr1_concat_noidx (n={n}) =====");
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {probe}")).unwrap();
        let mut rows = stmt.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            let detail: String = row.get(3).unwrap();
            println!("  {detail}");
        }
        println!("=========================================================\n");

        let mut group = c.benchmark_group(format!("cand_noidx_n{n}"));
        group.sample_size(20).measurement_time(Duration::from_secs(15));
        for (sel, q) in [("none", Q_NONE), ("common", Q_COMMON)] {
            let sql = format!(
                "SELECT {select_cols} FROM ghosts g WHERE g.request_key=? AND instr(g.search_text, ?) > 0 ORDER BY {ob} LIMIT ?"
            );
            group.bench_with_input(BenchmarkId::new("instr1_concat_noidx", sel), &sql, |b, sql| {
                b.iter(|| run_select(&conn, sql, rusqlite::params![RK, q, LIMIT]));
            });
        }
        group.finish();
    }
}

/// ソート index（Phase 2 予定形）共存時の「検索 × 非 name ソート」の実測。
/// プランナが sort-first（idx_cand_recent スキャン＋行 seek）と filter-first
/// （idx_cand_search_cover カバリング＋TEMP B-TREE）のどちらを選ぶか、
/// および INDEXED BY で両経路を強制した場合の上限/下限を測る。
fn bench_candidate_sort_search(c: &mut Criterion) {
    let select_cols = select_cols_prefixed();
    let ob_recent = order_by("recent");
    for &n in &[100_000usize] {
        let (_g, conn) = seeded_candidate_db(&format!("cand_sort_n{n}"), n);

        // プラン確認（empty+recent はソート index の効果検証・Phase 2 受け入れ形状）
        let probes: Vec<(&str, String)> = vec![
            ("empty_recent", format!(
                "SELECT {select_cols} FROM ghosts g WHERE g.request_key='{RK}' ORDER BY {ob_recent} LIMIT 50")),
            ("search_recent(planner)", format!(
                "SELECT {select_cols} FROM ghosts g WHERE g.request_key='{RK}' AND instr(g.search_text, 'さくら') > 0 ORDER BY {ob_recent} LIMIT 50")),
        ];
        println!("\n===== EXPLAIN QUERY PLAN 検索×ソート (n={n}) =====");
        for (label, sql) in probes {
            println!("--- {label} ---");
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            let mut rows = stmt.query([]).unwrap();
            while let Some(row) = rows.next().unwrap() {
                let detail: String = row.get(3).unwrap();
                println!("  {detail}");
            }
        }
        println!("==================================================\n");

        let mut group = c.benchmark_group(format!("cand_sort_n{n}"));
        group.sample_size(20).measurement_time(Duration::from_secs(15));

        // ソート index の単独効果（検索なし・Phase 2 の #136 受け入れ形状）
        let sql_empty = format!(
            "SELECT {select_cols} FROM ghosts g WHERE g.request_key=? ORDER BY {ob_recent} LIMIT ?"
        );
        group.bench_function("empty_recent", |b| {
            b.iter(|| run_select(&conn, &sql_empty, rusqlite::params![RK, LIMIT]));
        });

        for (sel, q) in [("none", Q_NONE), ("common", Q_COMMON)] {
            // プランナ任せ
            let sql = format!(
                "SELECT {select_cols} FROM ghosts g WHERE g.request_key=? AND instr(g.search_text, ?) > 0 ORDER BY {ob_recent} LIMIT ?"
            );
            group.bench_with_input(BenchmarkId::new("search_recent", sel), &sql, |b, sql| {
                b.iter(|| run_select(&conn, sql, rusqlite::params![RK, q, LIMIT]));
            });

            // filter-first を強制（カバリング index でフィルタ → マッチ行のみ TEMP B-TREE）
            let sql_f = format!(
                "SELECT {select_cols} FROM ghosts g INDEXED BY idx_cand_search_cover WHERE g.request_key=? AND instr(g.search_text, ?) > 0 ORDER BY {ob_recent} LIMIT ?"
            );
            group.bench_with_input(BenchmarkId::new("search_recent_filter_first", sel), &sql_f, |b, sql| {
                b.iter(|| run_select(&conn, sql, rusqlite::params![RK, q, LIMIT]));
            });

            // sort-first を強制（ソート index 順スキャン＋行 seek・マッチ 50 件で早期終了）
            let sql_s = format!(
                "SELECT {select_cols} FROM ghosts g INDEXED BY idx_cand_recent WHERE g.request_key=? AND instr(g.search_text, ?) > 0 ORDER BY {ob_recent} LIMIT ?"
            );
            group.bench_with_input(BenchmarkId::new("search_recent_sort_first", sel), &sql_s, |b, sql| {
                b.iter(|| run_select(&conn, sql, rusqlite::params![RK, q, LIMIT]));
            });
        }
        group.finish();
    }
}

/// ソート index に search_text を同乗させる複合案。sort-first スキャンが index 上で
/// instr を評価（行 seek なし）し、LIMIT 件のマッチで早期終了できるかを測る。
const CANDIDATE_DDL_SORTCOVER: &str = "\
ALTER TABLE ghosts ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
UPDATE ghosts SET search_text = name_lower || char(31) || sakura_name_lower || char(31) || kero_name_lower || char(31) || craftman_lower || char(31) || craftmanw_lower || char(31) || directory_name_lower;
CREATE INDEX idx_cand_recent_cover ON ghosts(request_key, last_launched DESC, name_lower, search_text);";

fn bench_candidate_sort_cover(c: &mut Criterion) {
    let select_cols = select_cols_prefixed();
    let ob_recent = order_by("recent");
    for &n in &[100_000usize] {
        let guard = tempfile_dir::Guard::new(&format!("cand_sortcover_n{n}"));
        let path = guard.path().join("ghosts.db");
        {
            let seed_conn = open_bench_db(&path).unwrap();
            seed_ghosts_db(&seed_conn, RK, n).unwrap();
            seed_conn.execute_batch(CANDIDATE_DDL_SORTCOVER).unwrap();
        }
        let conn = open_bench_db(&path).unwrap();

        let probe = format!(
            "SELECT {select_cols} FROM ghosts g WHERE g.request_key='{RK}' AND instr(g.search_text, 'さくら') > 0 ORDER BY {ob_recent} LIMIT 50"
        );
        println!("\n===== EXPLAIN QUERY PLAN 検索×recent（search_text 同乗 index）(n={n}) =====");
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {probe}")).unwrap();
        let mut rows = stmt.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            let detail: String = row.get(3).unwrap();
            println!("  {detail}");
        }
        println!("=====================================================================\n");

        let mut group = c.benchmark_group(format!("cand_sortcover_n{n}"));
        group.sample_size(20).measurement_time(Duration::from_secs(15));
        for (sel, q) in [("none", Q_NONE), ("common", Q_COMMON)] {
            let sql = format!(
                "SELECT {select_cols} FROM ghosts g WHERE g.request_key=? AND instr(g.search_text, ?) > 0 ORDER BY {ob_recent} LIMIT ?"
            );
            group.bench_with_input(BenchmarkId::new("search_recent_ridealong", sel), &sql, |b, sql| {
                b.iter(|| run_select(&conn, sql, rusqlite::params![RK, q, LIMIT]));
            });
        }
        group.finish();
    }
}

/// 候補形状の実測。like6_wide（現行本番形状）を同一 group に置き、同一 run 内のペア比較を成立させる。
fn bench_candidate_search(c: &mut Criterion) {
    let select_cols = select_cols_prefixed();
    let where6 = search_where_prefixed();
    let ob = order_by("name");
    for &n in &[10_000usize, 100_000] {
        let (_g, conn) = seeded_candidate_db(&format!("cand_n{n}"), n);
        let mut group = c.benchmark_group(format!("cand_search_n{n}"));
        if n >= 100_000 {
            group.sample_size(20).measurement_time(Duration::from_secs(15));
        }
        for (sel, q) in [("none", Q_NONE), ("common", Q_COMMON)] {
            let like = format!("%{q}%");

            // 対照: 現行 6 列 LIKE（幅広テーブル行の残余フィルタ）
            let sql6 = format!(
                "SELECT {select_cols} FROM ghosts g WHERE g.request_key=? AND ({where6}) ORDER BY {ob} LIMIT ?"
            );
            group.bench_with_input(BenchmarkId::new("like6_wide", sel), &sql6, |b, sql| {
                b.iter(|| {
                    run_select(&conn, sql, rusqlite::params![RK, like, like, like, like, like, like, LIMIT])
                });
            });

            // 案 A: 連結列 1 本への LIKE
            let sql_like1 = format!(
                "SELECT {select_cols} FROM ghosts g WHERE g.request_key=? AND g.search_text LIKE ? ORDER BY {ob} LIMIT ?"
            );
            group.bench_with_input(BenchmarkId::new("like1_concat", sel), &sql_like1, |b, sql| {
                b.iter(|| run_select(&conn, sql, rusqlite::params![RK, like, LIMIT]));
            });

            // 案 A+B: 連結列 1 本への instr()
            let sql_instr = format!(
                "SELECT {select_cols} FROM ghosts g WHERE g.request_key=? AND instr(g.search_text, ?) > 0 ORDER BY {ob} LIMIT ?"
            );
            group.bench_with_input(BenchmarkId::new("instr1_concat", sel), &sql_instr, |b, sql| {
                b.iter(|| run_select(&conn, sql, rusqlite::params![RK, q, LIMIT]));
            });

            // 案 A+B+C: カバリング index 上で id を絞ってから本体 50 行だけ引く
            let sql_cover = format!(
                "SELECT {select_cols} FROM ghosts g WHERE g.id IN (SELECT id FROM ghosts WHERE request_key=? AND instr(search_text, ?) > 0 ORDER BY name_lower LIMIT ?) ORDER BY {ob}"
            );
            group.bench_with_input(BenchmarkId::new("instr1_cover_subq", sel), &sql_cover, |b, sql| {
                b.iter(|| run_select(&conn, sql, rusqlite::params![RK, q, LIMIT]));
            });
        }
        group.finish();
    }
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

        // Phase 1 検収: COUNT 併走を外した select-only ページフェッチ。
        // count_plus_select_common との差が「スクロール毎に消えた COUNT 増幅」に相当する
        group.bench_function("select_only_common", |b| {
            b.iter(|| {
                let lc = &like_common;
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
    dump_candidate_plans();
    let mut c = Criterion::default().configure_from_args();
    bench_search(&mut c);
    bench_candidate_search(&mut c);
    bench_candidate_noidx(&mut c);
    bench_candidate_sort_search(&mut c);
    bench_candidate_sort_cover(&mut c);
    c.final_summary();
}
