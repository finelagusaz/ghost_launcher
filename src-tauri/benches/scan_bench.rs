//! FS走査層(scan/fingerprint/store)の計測。cargo bench --features bench --bench scan_bench

use std::path::{Path, PathBuf};
use std::time::Duration;

use criterion::Criterion;
use ghost_launcher_lib::bench_support::{
    add_one_ghost, fingerprint_only, full_scan_count, generate_ghost_tree, layer1_hit,
    open_bench_db, scan_entries_to_handle, scan_to_handle, store_delta_entries, store_handle,
    store_with_real_mtimes, walk_dir_mtime, walk_full, walk_nameset,
};

/// ベンチ用の一時ディレクトリガード（lib 内部 TempDirGuard は非 pub のためローカルに持つ）。
struct Guard(PathBuf);
impl Guard {
    fn new(tag: &str) -> Self {
        let mut base = std::env::temp_dir();
        base.push(format!("ghost_scan_bench_{tag}_{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        Guard(base)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn bench_scan(c: &mut Criterion) {
    for &n in &[1_000usize, 10_000, 100_000] {
        // ツリーは 1 回だけ生成（計測外）
        let guard = Guard::new(&format!("n{n}"));
        let ssp = guard.path().join("ssp");
        generate_ghost_tree(&ssp, n).unwrap();
        let ssp_str = ssp.to_string_lossy().to_string();

        // store 用に seed 済み DB（Layer1 hit と差分 store のセットアップ）
        let (handle, fp) = scan_to_handle(&ssp_str).unwrap();
        let db_path = guard.path().join("ghosts.db");

        let mut group = c.benchmark_group(format!("scan_n{n}"));
        if n >= 100_000 {
            group.sample_size(10).measurement_time(Duration::from_secs(30));
        } else {
            group.sample_size(20);
        }

        // フル走査（1 体増減毎に払うコスト）
        group.bench_function("full_scan", |b| {
            b.iter(|| full_scan_count(&ssp_str).unwrap());
        });

        // walk スペクトラム（parse 抜き・各 fidelity レベル）
        // 本番 walk（file_type・token+hash 込み）。full_scan との差が parse コスト。
        // Phase 2 で本番の逐次 is_dir は file_type 化済みのため、これが本番の walk 実体。
        group.bench_function("walk_full_fidelity", |b| {
            b.iter(|| fingerprint_only(&ssp_str).unwrap());
        });
        group.bench_function("walk_full_2stat_filetype", |b| {
            b.iter(|| walk_full(&ssp_str).unwrap());
        });
        group.bench_function("walk_dir_mtime_1stat", |b| {
            b.iter(|| walk_dir_mtime(&ssp_str).unwrap());
        });
        group.bench_function("walk_nameset_0stat", |b| {
            b.iter(|| walk_nameset(&ssp_str).unwrap());
        });

        // Layer1 hit（無変更時の高速パス）。実 mtimes を保存して真の hit にする。
        {
            let conn = open_bench_db(&db_path).unwrap();
            store_with_real_mtimes(&conn, "rk", &handle, &fp, &ssp_str).unwrap();
            debug_assert!(layer1_hit(&conn, "rk", &ssp_str), "layer1 は hit のはず");
            group.bench_function("layer1_hit", |b| {
                b.iter(|| layer1_hit(&conn, "rk", &ssp_str));
            });
        }

        // 初回 store（毎回空 DB に N INSERT）
        group.bench_function("store_initial", |b| {
            b.iter_batched(
                || {
                    let p = guard.path().join(format!("init_{}.db", fastrand_like()));
                    let conn = open_bench_db(&p).unwrap();
                    (conn, p)
                },
                |(conn, _p)| {
                    store_handle(&conn, "rk", &handle, &fp).unwrap();
                },
                criterion::BatchSize::PerIteration,
            );
        });

        // 差分ゼロ再 store（既存 N 行に同一 handle → 読み取り+比較オーバーヘッド）
        {
            let conn = open_bench_db(&guard.path().join("diff.db")).unwrap();
            store_handle(&conn, "rk", &handle, &fp).unwrap();
            group.bench_function("store_rescan_nodiff", |b| {
                b.iter(|| store_handle(&conn, "rk", &handle, &fp).unwrap());
            });
        }

        // 1体変更→再走査（before・全 parse）: setup で 1 体追加し Layer1 ミス+差分1を強制、
        // routine でフル walk+parse（scan_ghosts_with_fingerprint_internal 相当）+ store を測る。
        // Phase 2 の delta 導入前に相当する上限コスト（full_scan と同オーダー）。
        {
            let conn = open_bench_db(&guard.path().join("rescan.db")).unwrap();
            store_with_real_mtimes(&conn, "rk", &handle, &fp, &ssp_str).unwrap();
            group.bench_function("rescan_one_change", |b| {
                b.iter_batched(
                    || {
                        let tag = fastrand_like() as usize;
                        add_one_ghost(&ssp_str, tag).unwrap();
                    },
                    |_| {
                        let (h, f) = scan_to_handle(&ssp_str).unwrap();
                        store_handle(&conn, "rk", &h, &f).unwrap();
                    },
                    criterion::BatchSize::PerIteration,
                );
            });
        }

        // 1体変更→再走査（after・granular delta）: 本番の delta 経路を end-to-end で駆動する。
        // 差分走査（file_type walk・parse 抜き）+ apply_scan_delta（前回 scan_entries 読み → 差分 →
        // 変更子だけ parse → store_ghosts_delta）。Phase 2 の目標値（~1.05s warm）を実測する。
        {
            let conn = open_bench_db(&guard.path().join("rescan_delta.db")).unwrap();
            // 事前に現ツリーで seed（scan_entries も作り、以降の delta 差分を成立させる）
            let (h0, f0) = scan_entries_to_handle(&ssp_str).unwrap();
            store_delta_entries(&conn, "rk", &h0, &f0, &ssp_str).unwrap();
            group.bench_function("rescan_one_change_delta", |b| {
                b.iter_batched(
                    || {
                        let tag = fastrand_like() as usize;
                        add_one_ghost(&ssp_str, tag).unwrap();
                    },
                    |_| {
                        let (h, f) = scan_entries_to_handle(&ssp_str).unwrap();
                        store_delta_entries(&conn, "rk", &h, &f, &ssp_str).unwrap();
                    },
                    criterion::BatchSize::PerIteration,
                );
            });
        }

        group.finish();
    }
}

/// process id + 単調カウンタで一意なファイル名断片を作る（Math.random 不使用）。
fn fastrand_like() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static C: AtomicU64 = AtomicU64::new(0);
    C.fetch_add(1, Ordering::Relaxed)
}

fn main() {
    let mut c = Criterion::default().configure_from_args();
    bench_scan(&mut c);
    c.final_summary();
}
