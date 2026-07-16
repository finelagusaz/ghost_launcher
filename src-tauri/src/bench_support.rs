//! 10万体規模の性能計測用フィクスチャ生成器と本番経路ラッパー。
//! `bench` feature 有効時のみコンパイルされ、本番ビルドには含まれない。

use std::fs;
use std::path::{Path, PathBuf};

use rayon::prelude::*;
use rusqlite::Connection;

use crate::commands::ghost::store::{configure_connection, store_ghosts};
use crate::commands::ghost::{
    check_parent_mtimes_match, collect_parent_mtimes, scan_ghosts_with_fingerprint_internal, Ghost,
};

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

/// 検索対象の _lower 列（GHOST_SEARCH_LOWER_COLUMNS と一致）。真の権威は ghostDatabase.ts。
pub const SEARCH_LOWER_COLUMNS: [&str; 6] = [
    "name_lower",
    "sakura_name_lower",
    "kero_name_lower",
    "craftman_lower",
    "craftmanw_lower",
    "directory_name_lower",
];

/// searchGhosts と同形の WHERE（g. 前置き・6 列 OR）。
pub fn search_where_prefixed() -> String {
    SEARCH_LOWER_COLUMNS
        .iter()
        .map(|c| format!("g.{c} LIKE ?"))
        .collect::<Vec<_>>()
        .join(" OR ")
}

/// buildOrderBy(ghostDatabase.ts:212) と同形の ORDER BY 式。
/// random は固定シード/剰余で再現（本番は session シード）。
pub fn order_by(sort: &str) -> String {
    const RANDOM_SORT_MODULUS: u64 = 1000003;
    const BENCH_SEED: u64 = 2654435761 % RANDOM_SORT_MODULUS;
    match sort {
        "random" => format!("(g.id * {BENCH_SEED}) % {RANDOM_SORT_MODULUS}, g.id"),
        "recent" => "g.last_launched DESC NULLS LAST, g.name_lower ASC".to_string(),
        "frequency" => "g.launch_count DESC, g.name_lower ASC".to_string(),
        _ => "g.name_lower ASC".to_string(),
    }
}

/// {ssp_root}/ghost 配下に N 体のゴーストツリーを生成する。
/// - 全体に ghost/master/descript.txt（UTF-8、一部 Shift_JIS）
/// - i % 3 == 0 に shell/master/surface0.png（thumbnail 解決経路）
pub fn generate_ghost_tree(ssp_root: &Path, n: usize) -> Result<PathBuf, String> {
    let ghost_dir = ssp_root.join("ghost");
    fs::create_dir_all(&ghost_dir).map_err(|e| format!("mkdir ghost: {e}"))?;

    for i in 0..n {
        let g = synth_ghost(i);
        let master = ghost_dir.join(&g.directory_name).join("ghost").join("master");
        fs::create_dir_all(&master).map_err(|e| format!("mkdir master: {e}"))?;

        let descript = format!(
            "name,{}\nsakura.name,{}\nkero.name,{}\ncraftman,{}\n",
            g.name,
            if g.sakura_name.is_empty() { "" } else { &g.sakura_name },
            if g.kero_name.is_empty() { "" } else { &g.kero_name },
            g.craftman
        );
        let descript_path = master.join("descript.txt");
        if i % 7 == 0 {
            // Shift_JIS（charset 明示）で文字コード判定経路を踏む
            let sjis_body = format!("charset,Shift_JIS\n{descript}");
            let (bytes, _, _) = encoding_rs::SHIFT_JIS.encode(&sjis_body);
            fs::write(&descript_path, bytes).map_err(|e| format!("write sjis: {e}"))?;
        } else {
            let utf8_body = format!("charset,UTF-8\n{descript}");
            fs::write(&descript_path, utf8_body).map_err(|e| format!("write utf8: {e}"))?;
        }

        // 一部に surface0.png を置き thumbnail 解決を発生させる
        if i % 3 == 0 {
            let shell_master = ghost_dir.join(&g.directory_name).join("shell").join("master");
            fs::create_dir_all(&shell_master).map_err(|e| format!("mkdir shell: {e}"))?;
            fs::write(shell_master.join("surface0.png"), b"")
                .map_err(|e| format!("write png: {e}"))?;
        }
    }
    Ok(ssp_root.to_path_buf())
}

/// スキャン結果の Ghost 群を外部ベンチに対して opaque に保持する。
pub struct ScannedGhosts {
    ghosts: Vec<Ghost>,
}

/// フル走査を 1 回行い、opaque ハンドルと fingerprint を返す。
pub fn scan_to_handle(ssp_path: &str) -> Result<(ScannedGhosts, String), String> {
    let (ghosts, fp) = scan_ghosts_with_fingerprint_internal(ssp_path, &[])?;
    Ok((ScannedGhosts { ghosts }, fp))
}

/// ハンドルの Ghost 群を本番 store_ghosts で書き込む（差分 UPSERT）。
pub fn store_handle(
    conn: &Connection,
    request_key: &str,
    h: &ScannedGhosts,
    fp: &str,
) -> Result<usize, String> {
    store_ghosts(conn, request_key, &h.ghosts, fp, "bench-mtimes")
}

/// ハンドルを実際の親 mtime 付きで書き込む。これを使うと後続の layer1_hit が真に成立する
/// （store_handle は "bench-mtimes" 固定のため mtime 照合が必ず外れる）。
pub fn store_with_real_mtimes(
    conn: &Connection,
    request_key: &str,
    h: &ScannedGhosts,
    fp: &str,
    ssp_path: &str,
) -> Result<usize, String> {
    let mtimes = collect_parent_mtimes(ssp_path, &[]);
    store_ghosts(conn, request_key, &h.ghosts, fp, &mtimes)
}

/// フル走査を行い体数だけ返す（walk+parse コスト計測用）。
pub fn full_scan_count(ssp_path: &str) -> Result<usize, String> {
    let (ghosts, _fp) = scan_ghosts_with_fingerprint_internal(ssp_path, &[])?;
    Ok(ghosts.len())
}

/// フル fidelity walk を parse 抜きで実行し fingerprint を返す（walk_only 計測）。
/// full_scan_count との差が parse コスト。
pub fn fingerprint_only(ssp_path: &str) -> Result<String, String> {
    crate::commands::ghost::fingerprint_only_internal(ssp_path, &[])
}

/// {ssp}/ghost 直下の子ディレクトリパスを列挙する（is_dir 判定はキャッシュ済み
/// find-data の file_type を使い syscall ゼロ）。本番 walk_parent の is_dir(stat)
/// を file_type に置換したときの walk を模す計測用ヘルパー。
fn ghost_children(ssp_path: &str) -> Result<Vec<PathBuf>, String> {
    let ghost_dir = Path::new(ssp_path).join("ghost");
    let entries = fs::read_dir(&ghost_dir).map_err(|e| format!("read_dir: {e}"))?;
    Ok(entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .collect())
}

/// 名前集合レベル: 子1体あたり stat ゼロ（read_dir + file_type のみ）。
/// add/del/rename は検知できるが同名置換は検知できない fidelity 下限。
pub fn walk_nameset(ssp_path: &str) -> Result<usize, String> {
    Ok(ghost_children(ssp_path)?.len())
}

/// dir_mtime レベル: 子1体あたり fs::metadata 1 回（dir mtime のみ、descript stat なし）。
/// 同名置換まで検知できる。
pub fn walk_dir_mtime(ssp_path: &str) -> Result<usize, String> {
    let paths = ghost_children(ssp_path)?;
    let count = paths.par_iter().filter(|p| fs::metadata(p).is_ok()).count();
    Ok(count)
}

/// full fidelity レベル（file_type 版）: 子1体あたり 2 stat（dir mtime + descript）。
/// 本番 walk_parent は is_dir(stat) を足して 3 stat のため、fingerprint_only との差が
/// is_dir→file_type の無料削減効果。
pub fn walk_full(ssp_path: &str) -> Result<usize, String> {
    let paths = ghost_children(ssp_path)?;
    let count = paths
        .par_iter()
        .filter(|p| {
            let _dir = fs::metadata(p).is_ok(); // stat 1: dir mtime
            let descript = p.join("ghost").join("master").join("descript.txt");
            fs::metadata(&descript).is_ok() // stat 2: descript 有無/mtime（結果を使用）
        })
        .count();
    Ok(count)
}

/// Layer 1 高速パス（親 mtime 一致判定）を測る。事前に store_with_real_mtimes で
/// 保存していれば true（hit）、store_handle で保存していれば false（miss）を返すが、
/// 計測対象の「1 行 SELECT + 文字列比較」コストはどちらも同等。
pub fn layer1_hit(conn: &Connection, request_key: &str, ssp_path: &str) -> bool {
    let mtimes = collect_parent_mtimes(ssp_path, &[]);
    check_parent_mtimes_match(conn, request_key, &mtimes)
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
    fn sql形状が共有fixtureと一致する() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/test/fixtures/search-sql-shapes.json"
        );
        let raw = std::fs::read_to_string(path).expect("fixture を読めること");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();

        let cols: Vec<String> = v["searchLowerColumns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_string())
            .collect();
        assert_eq!(SEARCH_LOWER_COLUMNS.to_vec(), cols);

        assert_eq!(order_by("name"), v["orderBy"]["name"].as_str().unwrap());
        assert_eq!(order_by("recent"), v["orderBy"]["recent"].as_str().unwrap());
        assert_eq!(
            order_by("frequency"),
            v["orderBy"]["frequency"].as_str().unwrap()
        );
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
        // 上限も縛る: 全一致(選択率100%)への劣化を検出する（Q_RARE と同じ両側境界）
        assert!(count(Q_COMMON) > 500 && count(Q_COMMON) < 2000); // ~10% = ~1000
    }

    #[test]
    fn generate_ghost_tree_が_n_体を生成する() {
        let tmp = TempDirGuard::new("bench_tree");
        let ssp = tmp.path().join("ssp");
        let returned = generate_ghost_tree(&ssp, 20).unwrap();
        assert_eq!(returned, ssp);

        let ghost_dir = ssp.join("ghost");
        let count = std::fs::read_dir(&ghost_dir).unwrap().count();
        assert_eq!(count, 20);

        // 各体に descript.txt が存在する
        for entry in std::fs::read_dir(&ghost_dir).unwrap() {
            let d = entry.unwrap().path().join("ghost").join("master").join("descript.txt");
            assert!(d.exists(), "descript missing: {}", d.display());
        }
    }

    #[test]
    fn generate_ghost_tree_を本番スキャンが読める() {
        let tmp = TempDirGuard::new("bench_tree_scan");
        let ssp = tmp.path().join("ssp");
        generate_ghost_tree(&ssp, 30).unwrap();

        let (ghosts, _fp) = crate::commands::ghost::scan_ghosts_with_fingerprint_internal(
            &ssp.to_string_lossy(),
            &[],
        )
        .unwrap();
        assert_eq!(ghosts.len(), 30);
    }

    #[test]
    fn scan_to_handle_と_store_handle_が往復する() {
        let tmp = TempDirGuard::new("bench_scan_store");
        let ssp = tmp.path().join("ssp");
        generate_ghost_tree(&ssp, 40).unwrap();

        let (handle, fp) = scan_to_handle(&ssp.to_string_lossy()).unwrap();
        let db = tmp.path().join("ghosts.db");
        let conn = open_bench_db(&db).unwrap();
        let stored = store_handle(&conn, "rk", &handle, &fp).unwrap();
        assert_eq!(stored, 40);
        // 2 回目は差分ゼロ（同一 handle）→ 行数不変
        let stored2 = store_handle(&conn, "rk", &handle, &fp).unwrap();
        assert_eq!(stored2, 40);
    }

    #[test]
    fn full_scan_count_が体数を返す() {
        let tmp = TempDirGuard::new("bench_full_scan");
        let ssp = tmp.path().join("ssp");
        generate_ghost_tree(&ssp, 25).unwrap();
        assert_eq!(full_scan_count(&ssp.to_string_lossy()).unwrap(), 25);
    }

    #[test]
    fn fingerprint_only_がフルスキャンと同じfingerprintを返す() {
        let tmp = TempDirGuard::new("bench_fp_only");
        let ssp = tmp.path().join("ssp");
        generate_ghost_tree(&ssp, 30).unwrap();
        let ssp_str = ssp.to_string_lossy().to_string();

        let (_ghosts, full_fp) =
            crate::commands::ghost::scan_ghosts_with_fingerprint_internal(&ssp_str, &[]).unwrap();
        let walk_fp = fingerprint_only(&ssp_str).unwrap();

        // parse 抜き walk でも同一トークン集合 → 同一 fingerprint
        assert_eq!(walk_fp, full_fp);
    }

    #[test]
    fn walk_モデル3種が全て子ディレクトリ数を返す() {
        let tmp = TempDirGuard::new("bench_walk_levels");
        let ssp = tmp.path().join("ssp");
        generate_ghost_tree(&ssp, 50).unwrap();
        let ssp_str = ssp.to_string_lossy().to_string();

        assert_eq!(walk_nameset(&ssp_str).unwrap(), 50);
        assert_eq!(walk_dir_mtime(&ssp_str).unwrap(), 50);
        assert_eq!(walk_full(&ssp_str).unwrap(), 50);
        // 本番フル走査の体数とも一致（全子に descript 有り）
        assert_eq!(full_scan_count(&ssp_str).unwrap(), 50);
    }

    // ハーネス核心の不変条件を縛る（scan_bench の debug_assert! は bench プロファイルで no-op のため
    // ここで cargo test（debug-assertions 有効）による回帰ガードを置く）。
    #[test]
    fn store_with_real_mtimes_後は_layer1_hit_が_true() {
        let tmp = TempDirGuard::new("bench_layer1_hit");
        let ssp = tmp.path().join("ssp");
        generate_ghost_tree(&ssp, 10).unwrap();
        let ssp_str = ssp.to_string_lossy().to_string();

        let (handle, fp) = scan_to_handle(&ssp_str).unwrap();
        let conn = open_bench_db(&tmp.path().join("ghosts.db")).unwrap();
        store_with_real_mtimes(&conn, "rk", &handle, &fp, &ssp_str).unwrap();

        // 実 mtimes を保存したので、無変更のまま再照合すれば hit（Layer 1 高速パス成立）
        assert!(layer1_hit(&conn, "rk", &ssp_str), "実 mtimes 保存後は hit のはず");
    }

    #[test]
    fn store_handle_後は_layer1_hit_が_false() {
        let tmp = TempDirGuard::new("bench_layer1_miss");
        let ssp = tmp.path().join("ssp");
        generate_ghost_tree(&ssp, 10).unwrap();
        let ssp_str = ssp.to_string_lossy().to_string();

        let (handle, fp) = scan_to_handle(&ssp_str).unwrap();
        let conn = open_bench_db(&tmp.path().join("ghosts.db")).unwrap();
        store_handle(&conn, "rk", &handle, &fp).unwrap();

        // store_handle は parent_mtimes を "bench-mtimes" 固定で保存するため、
        // 実 mtimes（"path:nanos" 形式）とは決して一致せず miss になる
        assert!(!layer1_hit(&conn, "rk", &ssp_str), "bench-mtimes 固定後は miss のはず");
    }
}
