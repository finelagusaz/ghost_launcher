# 全走査スキャン粒度化 Phase 1（計測＝意思決定の計器）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `scan_bench` に walk の各 fidelity レベル分解・`rescan_one_change` 形状・キャッシュ mtime 信頼性テストを追加し、3.47秒の walk/parse 内訳と各検知レベルの walk コストを数値で確定して、Phase 2 の fidelity レベルを選ぶ材料を作る。

**Architecture:** 本番経路は一切変更しない。すべて `#[cfg(feature = "bench")]` ゲート下の計測専用コードを `src-tauri/src/bench_support.rs`・`src-tauri/benches/scan_bench.rs` に追加し、walk 単独コスト（parse 抜き）は本番 `walk_parent` を ghosts 収集なしで呼ぶ経路（scan.rs にベンチ専用内部関数を1本追加）で忠実計測する。各 fidelity レベル（full/dir_mtime/name-set）は bench_support 内の rayon 並列 walk モデルで見積もる。

**Tech Stack:** Rust / criterion 0.5 / rayon / rusqlite 0.32。ベンチは `cargo bench --features bench --bench scan_bench`。

## Global Constraints

- **本番 API・振る舞い・可視性を一切変更しない**。露出はすべて `#[cfg(feature = "bench")]` ゲート下（`src-tauri/CLAUDE.md`・PR #133 の方針を踏襲）。
- **CI は `--features bench` をビルドしない**ため、bench ゲート下の未使用警告は無害だが、`cargo test --features bench bench_support` は通ること。
- **`Date.now()`/乱数を使わない**（決定性）。一意名は `std::process::id()` ＋単調カウンタ（既存 `fastrand_like` パターン）で作る。
- **本計画は Phase 1 のみ**。Phase 2（差分検知＋変更子だけ parse・格納先案A・`store_ghosts_delta`）と Phase 3（非ブロッキング）の計画は、本 Phase の計測結果と「同名置換 fidelity を捨てるか」判断を得てから別途書き下ろす。migration は Phase 2 で追加（本 Phase では不要）。
- 設計書: `docs/superpowers/specs/2026-07-16-granular-scan-fingerprint-design.md`。

---

## Task 1: walk 単独コスト（parse 抜き・本番忠実）を露出する

full fidelity walk（read_dir + 3 stat/子 + トークン生成 + ハッシュ）を parse なしで測る。本番 `walk_parent` を ghosts 収集なしで呼ぶベンチ専用内部関数を scan.rs に1本追加し、`bench_support::fingerprint_only` として露出する。**parse コスト = full_scan − fingerprint_only** が判明する。

**Files:**
- Modify: `src-tauri/src/commands/ghost/scan.rs`（末尾にベンチ専用 `fingerprint_only_internal` を追加）
- Modify: `src-tauri/src/commands/ghost/mod.rs:12`（bench 再露出に `fingerprint_only_internal` を追加）
- Modify: `src-tauri/src/bench_support.rs`（`fingerprint_only` wrapper とテストを追加）

**Interfaces:**
- Consumes: 既存 `scan::walk_parent`, `scan::compute_fingerprint_hash`（`fingerprint.rs` からの再エクスポート）, `path_utils::unique_sorted_additional_folders`, 既存 `bench_support::{generate_ghost_tree, full_scan_count}`。
- Produces: `pub fn fingerprint_only(ssp_path: &str) -> Result<String, String>`（bench_support）。同一ツリーに対し `scan_ghosts_with_fingerprint_internal(ssp, &[]).1` と同じ fingerprint を返す（parse は fingerprint に影響しないため）。

- [ ] **Step 1: bench_support に失敗するテストを書く**

`src-tauri/src/bench_support.rs` の `#[cfg(test)] mod tests` 内に追加:

```rust
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
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `cargo test --features bench --manifest-path src-tauri/Cargo.toml bench_support::tests::fingerprint_only`
Expected: FAIL（`fingerprint_only` 未定義でコンパイルエラー）

- [ ] **Step 3: scan.rs にベンチ専用内部関数を追加**

`src-tauri/src/commands/ghost/scan.rs` の末尾（`scan_ghosts_with_fingerprint_internal` の直後）に追加:

```rust
/// フル走査と同じトークンを生成するが Ghost を収集しない（parse を行わない）。
/// walk 単独コスト（read_dir + stat + トークン生成 + ハッシュ）を parse 抜きで
/// 計測するためのベンチ専用経路。本番からは呼ばれない。
#[cfg(feature = "bench")]
pub(crate) fn fingerprint_only_internal(
    ssp_path: &str,
    additional_folders: &[String],
) -> Result<String, String> {
    let ghost_dir = Path::new(ssp_path).join("ghost");
    let mut tokens = vec!["fingerprint-version|1".to_string()];

    walk_parent(&ghost_dir, "ssp", true, &mut tokens, None)?;
    for (_source, folder_path, normalized_folder) in
        unique_sorted_additional_folders(additional_folders)
    {
        walk_parent(&folder_path, &normalized_folder, false, &mut tokens, None)?;
    }

    Ok(compute_fingerprint_hash(&tokens))
}
```

- [ ] **Step 4: mod.rs の bench 再露出に追加**

`src-tauri/src/commands/ghost/mod.rs:12` を次のように変更:

```rust
#[cfg(feature = "bench")]
pub(crate) use scan::{fingerprint_only_internal, scan_ghosts_with_fingerprint_internal};
```

- [ ] **Step 5: bench_support に wrapper を追加**

`src-tauri/src/bench_support.rs` の `full_scan_count` の直後に追加:

```rust
/// フル fidelity walk を parse 抜きで実行し fingerprint を返す（walk_only 計測）。
/// full_scan_count との差が parse コスト。
pub fn fingerprint_only(ssp_path: &str) -> Result<String, String> {
    crate::commands::ghost::fingerprint_only_internal(ssp_path, &[])
}
```

- [ ] **Step 6: テストを実行して成功を確認**

Run: `cargo test --features bench --manifest-path src-tauri/Cargo.toml bench_support::tests::fingerprint_only`
Expected: PASS

- [ ] **Step 7: コミット**

```bash
git add src-tauri/src/commands/ghost/scan.rs src-tauri/src/commands/ghost/mod.rs src-tauri/src/bench_support.rs
git commit -m "test: walk 単独コスト計測用 fingerprint_only をベンチ露出（#134 Phase1）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 各 fidelity レベルの walk コストモデルを追加する

3 レベル（name-set=0 stat / dir_mtime=1 stat / full=2 stat・file_type 版）を bench_support 内の rayon 並列 walk モデルとして実装する。`fingerprint_only`（本番 3 stat・is_dir 版）との比較で、is_dir→file_type の無料削減効果（stat 1 回分）も見積もる。ベンチは常に additional_folders 空（既存 scan_bench と同じ前提）で `{ssp}/ghost` のみ walk する。

**Files:**
- Modify: `src-tauri/src/bench_support.rs`（`ghost_children` ヘルパー＋ 3 walk モデル＋テストを追加）

**Interfaces:**
- Consumes: 既存 `bench_support::{generate_ghost_tree, full_scan_count}`、`rayon::prelude`、std `fs`/`Path`。
- Produces:
  - `pub fn walk_nameset(ssp_path: &str) -> Result<usize, String>`（0 stat/子）
  - `pub fn walk_dir_mtime(ssp_path: &str) -> Result<usize, String>`（1 stat/子）
  - `pub fn walk_full(ssp_path: &str) -> Result<usize, String>`（2 stat/子・file_type で is_dir 判定）
  - いずれも生成ツリーの子ディレクトリ数（= N）を返す。

- [ ] **Step 1: 失敗するテストを書く**

`src-tauri/src/bench_support.rs` の `#[cfg(test)] mod tests` 内に追加:

```rust
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
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `cargo test --features bench --manifest-path src-tauri/Cargo.toml bench_support::tests::walk_モデル3種`
Expected: FAIL（`walk_nameset` 等が未定義でコンパイルエラー）

- [ ] **Step 3: ヘルパーと 3 モデルを実装**

`src-tauri/src/bench_support.rs` の `fingerprint_only`（Task 1 で追加）の直後に追加。ファイル冒頭の `use` に `use rayon::prelude::*;` が無ければ追加する:

```rust
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
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `cargo test --features bench --manifest-path src-tauri/Cargo.toml bench_support::tests::walk_モデル3種`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/bench_support.rs
git commit -m "test: fidelity 3レベルの walk コストモデルを追加（#134 Phase1）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 1体変更→再走査（rescan_one_change）ベースライン形状

現行コードの「1体増減→ Layer 1 ミス→再走査」end-to-end（フル walk+parse + store 差分1件）を測る。`iter_batched` の setup で**毎イテレーション一意名のゴースト1体を追加**し（`ghost/` mtime を bump → Layer 1 ミス相当、差分ちょうど1）、routine で本番の miss 経路（`scan_to_handle` + `store_handle`）を走らせる。Phase 2 の granular 版と直接比較する before 値。

**Files:**
- Modify: `src-tauri/src/bench_support.rs`（`add_one_ghost` ヘルパー＋テストを追加）
- Modify: `src-tauri/benches/scan_bench.rs`（`rescan_one_change` bench 行を追加）

**Interfaces:**
- Consumes: 既存 `bench_support::{generate_ghost_tree, scan_to_handle, store_handle, store_with_real_mtimes, open_bench_db}`、scan_bench の `Guard`・`fastrand_like`。
- Produces: `pub fn add_one_ghost(ssp_path: &str, tag: usize) -> Result<(), String>`（一意名 `dir_added_{tag:09}` のゴーストを追加。既存 mtime を bump）。

- [ ] **Step 1: add_one_ghost の失敗するテストを書く**

`src-tauri/src/bench_support.rs` の `#[cfg(test)] mod tests` 内に追加:

```rust
    #[test]
    fn add_one_ghost_が体数を1増やしlayer1をミスさせる() {
        let tmp = TempDirGuard::new("bench_add_one");
        let ssp = tmp.path().join("ssp");
        generate_ghost_tree(&ssp, 20).unwrap();
        let ssp_str = ssp.to_string_lossy().to_string();

        // 初期状態を real mtimes で保存 → layer1 hit する
        let (handle, fp) = scan_to_handle(&ssp_str).unwrap();
        let conn = open_bench_db(&tmp.path().join("ghosts.db")).unwrap();
        store_with_real_mtimes(&conn, "rk", &handle, &fp, &ssp_str).unwrap();
        assert!(layer1_hit(&conn, "rk", &ssp_str));

        // 1 体追加 → 体数 +1、layer1 ミス
        add_one_ghost(&ssp_str, 1).unwrap();
        assert_eq!(full_scan_count(&ssp_str).unwrap(), 21);
        assert!(!layer1_hit(&conn, "rk", &ssp_str), "追加で親 mtime が変わり miss のはず");
    }
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `cargo test --features bench --manifest-path src-tauri/Cargo.toml bench_support::tests::add_one_ghost`
Expected: FAIL（`add_one_ghost` 未定義）

- [ ] **Step 3: add_one_ghost を実装**

`src-tauri/src/bench_support.rs` の `generate_ghost_tree` の直後に追加:

```rust
/// 既存ツリーに一意名（dir_added_{tag}）のゴースト1体を追加する。
/// 親 {ssp}/ghost の mtime を bump するため、以後の layer1 判定はミスする。
pub fn add_one_ghost(ssp_path: &str, tag: usize) -> Result<(), String> {
    let master = Path::new(ssp_path)
        .join("ghost")
        .join(format!("dir_added_{tag:09}"))
        .join("ghost")
        .join("master");
    fs::create_dir_all(&master).map_err(|e| format!("mkdir added: {e}"))?;
    fs::write(
        master.join("descript.txt"),
        format!("charset,UTF-8\nname,追加{tag}\n"),
    )
    .map_err(|e| format!("write added: {e}"))
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `cargo test --features bench --manifest-path src-tauri/Cargo.toml bench_support::tests::add_one_ghost`
Expected: PASS

- [ ] **Step 5: scan_bench に rescan_one_change 行を追加**

`src-tauri/benches/scan_bench.rs` の import に `add_one_ghost` を追加し、`store_rescan_nodiff` ブロックの直後（`group.finish()` の前）に追加:

```rust
        // 1体変更→再走査（現行ベースライン）: setup で 1 体追加し Layer1 ミス+差分1を強制、
        // routine でフル walk+parse + store 差分（現行の miss 経路）を測る。
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
```

`use ghost_launcher_lib::bench_support::{...}` の列に `add_one_ghost` を加える。

- [ ] **Step 6: ベンチがコンパイル・小規模で走ることを確認**

Run: `cargo bench --features bench --manifest-path src-tauri/Cargo.toml --bench scan_bench -- scan_n1000/rescan_one_change --quick`
Expected: コンパイル成功し `scan_n1000/rescan_one_change` の計測が出力される（値の妥当性は Task 6 で確認）

- [ ] **Step 7: コミット**

```bash
git add src-tauri/src/bench_support.rs src-tauri/benches/scan_bench.rs
git commit -m "test: rescan_one_change ベースライン形状を scan_bench に追加（#134 Phase1）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: walk レベル 3 種を scan_bench に組み込む

Task 2 の 3 モデルと Task 1 の `fingerprint_only` を、既存 `scan_n{N}` グループに bench 行として追加する。これでスペクトラム（full/dir_mtime/name-set の walk コスト）が N=1k/10k/100k で採れる。

**Files:**
- Modify: `src-tauri/benches/scan_bench.rs`（4 bench 行を追加・import 拡張）

**Interfaces:**
- Consumes: `bench_support::{fingerprint_only, walk_full, walk_dir_mtime, walk_nameset}`（Task 1・2）。
- Produces: なし（bench 出力のみ）。

- [ ] **Step 1: import を拡張し 4 行を追加**

`src-tauri/benches/scan_bench.rs` の `use ghost_launcher_lib::bench_support::{...}` に
`fingerprint_only, walk_full, walk_dir_mtime, walk_nameset` を追加。既存 `full_scan` bench 行の直後に追加:

```rust
        // walk スペクトラム（parse 抜き・各 fidelity レベル）
        group.bench_function("walk_full_fidelity_3stat", |b| {
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
```

- [ ] **Step 2: 小規模で走ることを確認**

Run: `cargo bench --features bench --manifest-path src-tauri/Cargo.toml --bench scan_bench -- scan_n1000/walk --quick`
Expected: `walk_full_fidelity_3stat` / `walk_full_2stat_filetype` / `walk_dir_mtime_1stat` / `walk_nameset_0stat` の 4 行が計測される

- [ ] **Step 3: コミット**

```bash
git add src-tauri/benches/scan_bench.rs
git commit -m "test: walk スペクトラム4行を scan_bench に組み込み（#134 Phase1）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: キャッシュ mtime 信頼性テスト

`entry.metadata()`（キャッシュ済み find-data 由来・syscall ゼロ）の mtime が、ツリー変更後の**新しい read_dir 列挙**で `fs::metadata` と一致するかを検証する。一致すれば dir_mtime レベルを 0 syscall で実現でき、dir_mtime レベルがほぼ無料化しうる。**このテストの合否そのものが所見**（無理に pass させず、失敗したら Task 6 に「dir_mtime は find-data mtime を使えない」と記録する）。

**Files:**
- Modify: `src-tauri/src/bench_support.rs`（`#[cfg(test)]` にテストを追加）

**Interfaces:**
- Consumes: `bench_support::{generate_ghost_tree}`、`TempDirGuard`、std `fs`。
- Produces: なし（テストの合否が所見）。

- [ ] **Step 1: 信頼性テストを書く**

`src-tauri/src/bench_support.rs` の `#[cfg(test)] mod tests` 内に追加:

```rust
    #[test]
    fn キャッシュmtimeが新しい列挙で更新を反映する() {
        use std::time::Duration;
        let tmp = TempDirGuard::new("bench_mtime_reliability");
        let ssp = tmp.path().join("ssp");
        generate_ghost_tree(&ssp, 5).unwrap();
        let ghost_dir = ssp.join("ghost");

        // 対象の子ディレクトリを1つ選ぶ
        let target = ghost_dir.join("dir_000000");

        // mtime を確実に前進させるため、少し待ってから中身を更新する
        std::thread::sleep(Duration::from_millis(50));
        fs::write(
            target.join("ghost").join("master").join("descript.txt"),
            "charset,UTF-8\nname,更新後\n",
        )
        .unwrap();
        // ディレクトリ自身の mtime を bump するためファイルを1つ足す
        fs::write(target.join("touch.tmp"), b"x").unwrap();

        // 変更後に「新しい read_dir 列挙」で entry.metadata() と fs::metadata を比較
        let mut cached = None;
        for entry in fs::read_dir(&ghost_dir).unwrap() {
            let entry = entry.unwrap();
            if entry.path() == target {
                cached = entry.metadata().ok().and_then(|m| m.modified().ok());
            }
        }
        let fresh = fs::metadata(&target).ok().and_then(|m| m.modified().ok());

        // 新しい列挙のキャッシュ mtime が fs::metadata と一致するか（所見）。
        // 一致するなら dir_mtime レベルは find-data mtime で 0 syscall 化できる。
        assert_eq!(
            cached, fresh,
            "新しい read_dir 列挙の entry.metadata() mtime が fs::metadata と不一致。\
             dir_mtime レベルは find-data mtime を使えない（fs::metadata で 1 stat 必要）。"
        );
    }
```

- [ ] **Step 2: テストを実行して合否を記録**

Run: `cargo test --features bench --manifest-path src-tauri/Cargo.toml bench_support::tests::キャッシュmtime`
Expected: PASS または FAIL。**どちらでも所見**。FAIL なら「find-data mtime は新しい列挙でも陳腐化しうる → dir_mtime は fs::metadata 必須」を Task 6 に記録し、テストを `#[ignore]` にして所見コメントを添える（削除しない）。PASS なら「find-data mtime は新しい列挙で信頼できる → dir_mtime は 0 syscall 化可能」を記録する。

- [ ] **Step 3: コミット**

```bash
git add src-tauri/src/bench_support.rs
git commit -m "test: キャッシュ mtime 信頼性テストを追加（#134 Phase1）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 全ベンチ実走と所見の記録

拡張した `scan_bench` を N=1k/10k/100k で実走し、walk スペクトラム・rescan_one_change・parse 内訳を `docs/perf/granular-scan-spectrum-100k.md` に記録する。Task 5 の信頼性所見も併記する。**この数値が Phase 2 の fidelity レベル決定の材料**。

**Files:**
- Create: `docs/perf/granular-scan-spectrum-100k.md`

**Interfaces:**
- Consumes: 拡張済み `scan_bench`。
- Produces: 計測記録 doc（Phase 2 計画の入力）。

- [ ] **Step 1: フル回帰（feature 無効・本番非影響）を確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS（bench feature 無効で本番テストが崩れていないこと）

Run: `cargo test --features bench --manifest-path src-tauri/Cargo.toml bench_support`
Expected: PASS（Task 5 が `#[ignore]` の場合はその1件が ignored 表示）

- [ ] **Step 2: scan_bench を実走**

Run: `cargo bench --features bench --manifest-path src-tauri/Cargo.toml --bench scan_bench`
Expected: `scan_n1000` / `scan_n10000` / `scan_n100000` の各グループで、既存行（full_scan/layer1_hit/store_*）＋新規行（walk_full_fidelity_3stat / walk_full_2stat_filetype / walk_dir_mtime_1stat / walk_nameset_0stat / rescan_one_change）の中央値が出力される。100k は sample_size=10 の indicative 値（数分かかる）。

- [ ] **Step 3: 所見 doc を作成**

`docs/perf/granular-scan-spectrum-100k.md` を作成。`docs/perf/baseline-100k.md` の書式に倣い、以下を埋める（数値は Step 2 の実測で置換）:

```markdown
# walk スペクトラム計測（10万体規模・#134 Phase 1）

- 計測日: <実走日>
- 目的: Phase 2 の fidelity レベル（full/dir_mtime/name-set）を選ぶための walk/parse 内訳。
- 実行環境: <docs/perf/baseline-100k.md と同一環境なら参照。異なれば明記>
- 手順: `cargo bench --features bench --bench scan_bench`

## walk スペクトラムと parse 内訳

| 形状 | n=1k | n=10k | n=100k(indicative) |
|---|---|---|---|
| full_scan（walk+parse） | | | |
| walk_full_fidelity_3stat（本番 walk・parse抜き） | | | |
| walk_full_2stat_filetype（is_dir→file_type） | | | |
| walk_dir_mtime_1stat | | | |
| walk_nameset_0stat | | | |
| rescan_one_change（現行 1体変更→再走査） | | | |

- **parse コスト** = full_scan − walk_full_fidelity_3stat = <値>（parse 支配か walk 支配かの判定）
- **is_dir→file_type の無料削減** = walk_full_fidelity_3stat − walk_full_2stat_filetype = <値>
- **fidelity ツマミの幅** = walk_full_2stat_filetype − walk_nameset_0stat = <値>

## キャッシュ mtime 信頼性（Task 5 所見）

- 結果: PASS / FAIL（<新しい列挙の find-data mtime が fs::metadata と一致したか>）
- 含意: dir_mtime レベルを 0 syscall 化できるか / fs::metadata が必須か

## Phase 2 への含意（fidelity レベル選択）

- parse 支配なら: full fidelity granular で rescan は walk_full 相当（<値>）に落ち、体感フリーズ<有無>。同名置換 fidelity を保てる。
- walk 支配なら: name-set レベル（<値>）でないと単体パース相当に届かない。同名置換検知を失う（§2.2）。
- Phase 3（非ブロッキング）の要否: 選んだレベルの walk 残余（<値>）が体感フリーズ閾値を<超える/超えない>。
```

- [ ] **Step 4: コミット**

```bash
git add docs/perf/granular-scan-spectrum-100k.md
git commit -m "docs: walk スペクトラム計測結果を記録（#134 Phase1）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 1 完了後の次アクション（本計画外）

計測 doc（Task 6）を根拠に:
1. **fidelity レベルを決定**（full/dir_mtime/name-set。争点は「同名置換検知を捨てるか」§2.2）。
2. **Phase 3 の要否を判定**（選んだレベルの walk 残余が体感フリーズを起こすか）。
3. 上記を踏まえ **Phase 2 の実装計画を別途書き下ろす**（格納先案A `ghost_scan_entries` migration・`store_ghosts_delta`・生キー差分・delta 正しさ規則 §4.4・is_dir→file_type の本番適用）。
```
