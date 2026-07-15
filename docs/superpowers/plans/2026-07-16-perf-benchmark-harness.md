# 10万体規模の性能計測ハーネス Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 10万体規模のゴーストでどこが性能ボトルネックになるかを実測するため、SQL層(search/sort/OFFSET)とFS走査層(scan/fingerprint/store)を計測する常設ハーネスとベースライン数値を構築する。

**Architecture:** `bench` feature 下でのみ本番内部関数を最小限 pub 露出し、`bench_support` モジュールが合成フィクスチャ生成器(SQL seeder / FS tree generator)と本番経路への薄いラッパーを提供する。criterion ベンチ2本(`search_bench` / `scan_bench`)がそれを駆動し、`EXPLAIN QUERY PLAN` と N を振ったレイテンシを吐く。修正は本ハーネスの数値を見て別サイクルで行う。

**Tech Stack:** Rust (rusqlite 0.32 bundled, rayon, unicode-normalization, encoding_rs), criterion 0.5, TypeScript/vitest(パリティテスト)。

## Global Constraints

- **rusqlite は 0.32 に固定**（`tauri-plugin-sql` の libsqlite3-sys 共有制約。`src-tauri/CLAUDE.md`）。criterion は sqlite にリンクしない純 Rust dev-dependency ゆえ制約に影響しない。
- **`bench` feature は本番 API・可視性を変えてはならない**。露出はすべて `#[cfg(feature = "bench")]` ガード下に置き、feature 無効の `cargo build`/`cargo check` は従来通り通ること。
- **既にリリース・コミット済みの migration SQL は絶対に編集しない**（sqlx チェックサム。`src-tauri/CLAUDE.md`）。本計画は migration を追加も編集もしない。
- **コードコメントは日本語**。UI テキストは日本語。
- Rust edition 2024 / rust-version 1.93。
- 検索の WHERE 列・ORDER BY 式は `src/lib/ghostDatabase.ts` が真の権威。ベンチ側の複製は共有 fixture `src/test/fixtures/search-sql-shapes.json` でパリティを縛る。
- FS フィクスチャの生成先は scratchpad の temp（非コミット）。`TempDirGuard`（`src-tauri/src/testutil.rs`）流儀で確実削除する。

---

## Task 1: bench feature の配線と bench_support スケルトン

feature フラグ・criterion 依存・feature ゲート付き再エクスポート・空の `bench_support` を用意し、`--features bench` あり/なし双方でコンパイルが通る土台を作る。

**Files:**
- Modify: `src-tauri/Cargo.toml`（`[features]`・`[dev-dependencies]` に criterion 追加）
- Modify: `src-tauri/src/lib.rs:4` 付近（`pub(crate) mod testutil;` の並びに feature ゲート付き `pub mod bench_support;` を追加）
- Modify: `src-tauri/src/commands/ghost/mod.rs:6` 付近（`mod types;` の後に feature ゲート付き再エクスポート）
- Create: `src-tauri/src/bench_support.rs`

**Interfaces:**
- Produces: `#[cfg(feature = "bench")] pub mod bench_support`（クレートルート）。以降のタスクが中身を埋める。
- Produces（feature ゲート下の crate 内可視化）: `crate::commands::ghost::{Ghost, scan_ghosts_with_fingerprint_internal, check_parent_mtimes_match, collect_parent_mtimes}`。

- [ ] **Step 1: criterion を dev-dependency に追加**

`src-tauri/Cargo.toml` の `[dev-dependencies]` を次にする（`ts-rs` は既存）:

```toml
[features]
bench = []

[dev-dependencies]
ts-rs = "12"
criterion = "0.5"
```

- [ ] **Step 2: ghost モジュールに feature ゲート付き再エクスポートを追加**

`src-tauri/src/commands/ghost/mod.rs` の先頭のモジュール宣言群（`mod types;` まで）の直後に追記する:

```rust
// ベンチ計測用の内部関数・型の最小露出。feature 無効時は一切影響しない。
#[cfg(feature = "bench")]
pub(crate) use fingerprint::{check_parent_mtimes_match, collect_parent_mtimes};
#[cfg(feature = "bench")]
pub(crate) use scan::scan_ghosts_with_fingerprint_internal;
#[cfg(feature = "bench")]
pub(crate) use types::Ghost;
```

- [ ] **Step 3: lib.rs に bench_support モジュールを宣言**

`src-tauri/src/lib.rs` の `pub(crate) mod testutil;`（4 行目付近）の直後に追記する:

```rust
#[cfg(feature = "bench")]
pub mod bench_support;
```

- [ ] **Step 4: bench_support.rs にスモークテスト付きスケルトンを作成**

`src-tauri/src/bench_support.rs` を新規作成する:

```rust
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
        // 全てに触れることで feature ビルドの unused 警告も防ぐ。
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
```

- [ ] **Step 5: 両ビルドが通ることを確認**

Run:
```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --features bench bench_support
```
Expected: 1つ目（feature 無効）が警告なく通る。2つ目で `bench_support::tests` の2件が PASS。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/src/commands/ghost/mod.rs src-tauri/src/bench_support.rs
git commit -m "$(cat <<'EOF'
test: 性能計測ハーネスの bench feature 配線と bench_support スケルトン

bench feature 下でのみ内部関数(scan/fingerprint/Ghost)を最小露出し、
本番ビルドには一切影響しない土台を作る。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: SQL seeder（FS 非依存の行投入）

一時ファイル DB に本番読み取り接続と同じ PRAGMA を設定し、現実寄せ分布の N 行を本番の `store_ghosts` 経由で投入する。recent/frequency ソートの現実性のため起動集計列をばらけさせる。

**Files:**
- Modify: `src-tauri/src/bench_support.rs`
- Test: `src-tauri/src/bench_support.rs`（`#[cfg(test)] mod tests`）

**Interfaces:**
- Consumes: `crate::commands::ghost::Ghost`、`crate::commands::ghost::store::{store_ghosts, configure_connection}`、`crate::migrations()`。
- Produces:
  - `pub fn open_bench_db(path: &std::path::Path) -> Result<Connection, String>` — migrations 適用 + 本番読み取り PRAGMA。
  - `pub fn seed_ghosts_db(conn: &Connection, request_key: &str, n: usize) -> Result<(), String>` — N 行投入 + 起動集計列 sprinkle。
  - クエリ定数: `pub const Q_NONE: &str`（0件）, `pub const Q_RARE: &str`（~0.1%）, `pub const Q_COMMON: &str`（~10%）。

- [ ] **Step 1: 失敗するテストを書く**

`src-tauri/src/bench_support.rs` の `mod tests` に追加する:

```rust
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
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --features bench bench_support::tests`
Expected: FAIL（`open_bench_db`/`seed_ghosts_db`/`Q_NONE` 未定義でコンパイルエラー）。

- [ ] **Step 3: seeder を実装**

`src-tauri/src/bench_support.rs` の冒頭 use と本体を実装する（`__bench_support_linked` は残してよい）:

```rust
use std::path::Path;

use rusqlite::Connection;

use crate::commands::ghost::store::{configure_connection, store_ghosts};
use crate::commands::ghost::Ghost;

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
```

> 注: `open_bench_db` は読み取り計測用 PRAGMA を張るが、`seed_ghosts_db` 内で `configure_connection`（書き込み PRAGMA）を上書きする。search ベンチは「seed 後に別接続で開き直す」ことで読み取り PRAGMA を保証する（Task 4 で担保）。

- [ ] **Step 4: テストが通ることを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --features bench bench_support::tests`
Expected: 全 PASS（Task 1 の2件 + 本タスクの4件）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/bench_support.rs
git commit -m "$(cat <<'EOF'
test: SQL層ベンチ用の行 seeder を追加

本番 store_ghosts 経由で現実寄せ分布の N 行を投入し、0件/希少/多数の
固定クエリと起動集計列の sprinkle を用意する。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: SQL 形状ビルダーと言語間パリティ fixture

検索の WHERE 列と ORDER BY 式を Rust/TS 双方が共有 fixture に対して縛る。これによりベンチの計測対象が本番クエリ形状からずれれば TS/Rust いずれかのテストが Red になる。

**Files:**
- Create: `src/test/fixtures/search-sql-shapes.json`
- Modify: `src-tauri/src/bench_support.rs`（ビルダー + Rust パリティテスト）
- Modify: `src/lib/ghostDatabase.ts:178`（`GHOST_SEARCH_LOWER_COLUMNS` を export）
- Create: `src/lib/searchSqlShapes.parity.test.ts`

**Interfaces:**
- Produces（Rust）:
  - `pub const SEARCH_LOWER_COLUMNS: [&str; 6]`
  - `pub fn search_where_prefixed() -> String`（`g.col LIKE ? OR …`、searchGhosts と同形）
  - `pub fn order_by(sort: &str) -> String`（name/recent/frequency/random）
- Produces（TS）: `export const GHOST_SEARCH_LOWER_COLUMNS`。

- [ ] **Step 1: 共有 fixture を作成**

`src/test/fixtures/search-sql-shapes.json`:

```json
{
  "searchLowerColumns": [
    "name_lower",
    "sakura_name_lower",
    "kero_name_lower",
    "craftman_lower",
    "craftmanw_lower",
    "directory_name_lower"
  ],
  "orderBy": {
    "name": "g.name_lower ASC",
    "recent": "g.last_launched DESC NULLS LAST, g.name_lower ASC",
    "frequency": "g.launch_count DESC, g.name_lower ASC"
  }
}
```

> `random` は session シードを含み動的なため、パリティ縛りの対象外（ベンチ側は固定シードで再現）。

- [ ] **Step 2: Rust パリティテストを書く（失敗する）**

`src-tauri/src/bench_support.rs` の `mod tests` に追加:

```rust
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
```

（`serde_json` は src-tauri の通常依存にあり、テストから利用可。）

- [ ] **Step 3: テストが失敗することを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --features bench bench_support::tests::sql形状`
Expected: FAIL（`SEARCH_LOWER_COLUMNS`/`order_by` 未定義）。

- [ ] **Step 4: ビルダーを実装**

`src-tauri/src/bench_support.rs` に追加（ghostDatabase.ts:178/212/267 と同形に保つ）:

```rust
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
```

- [ ] **Step 5: Rust テストが通ることを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --features bench bench_support::tests`
Expected: 全 PASS。

- [ ] **Step 6: TS 側で列定数を export**

`src/lib/ghostDatabase.ts:178` の `const GHOST_SEARCH_LOWER_COLUMNS` を `export const GHOST_SEARCH_LOWER_COLUMNS` に変更する（値・利用箇所は不変）。

- [ ] **Step 7: TS パリティテストを書く**

`src/lib/searchSqlShapes.parity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import shapes from "../test/fixtures/search-sql-shapes.json";
import { GHOST_SEARCH_LOWER_COLUMNS, buildOrderBy } from "./ghostDatabase";

describe("検索 SQL 形状の言語間パリティ", () => {
  it("検索対象列が fixture と一致する", () => {
    expect([...GHOST_SEARCH_LOWER_COLUMNS]).toEqual(shapes.searchLowerColumns);
  });

  it("name/recent/frequency の ORDER BY が fixture と一致する", () => {
    expect(buildOrderBy("name")).toBe(shapes.orderBy.name);
    expect(buildOrderBy("recent")).toBe(shapes.orderBy.recent);
    expect(buildOrderBy("frequency")).toBe(shapes.orderBy.frequency);
  });
});
```

- [ ] **Step 8: TS テストが通ることを確認**

Run: `npx vitest run src/lib/searchSqlShapes.parity.test.ts`
Expected: PASS（2 件）。tsconfig の `resolveJsonModule` が無効ならエラーになるため、その場合は `tsconfig.json` の `compilerOptions` に `"resolveJsonModule": true` を追加する。

- [ ] **Step 9: Commit**

```bash
git add src/test/fixtures/search-sql-shapes.json src-tauri/src/bench_support.rs src/lib/ghostDatabase.ts src/lib/searchSqlShapes.parity.test.ts
git commit -m "$(cat <<'EOF'
test: 検索 SQL 形状の Rust/TS パリティ fixture を追加

WHERE 列と ORDER BY 式を共有 fixture で縛り、ベンチの計測対象が本番
クエリ形状からずれれば Red になるようにする。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: search_bench（SQL 層 criterion ベンチ）

seed 済み DB を本番読み取り PRAGMA で開き直し、空/LIKE 3 種/sort 4 種/OFFSET 3 深度/COUNT+SELECT 併走を N∈{1k,10k,100k} で計測。各形状の `EXPLAIN QUERY PLAN` を先に出力する。

**Files:**
- Create: `src-tauri/benches/search_bench.rs`
- Modify: `src-tauri/Cargo.toml`（`[[bench]]` エントリ）

**Interfaces:**
- Consumes: `ghost_launcher_lib::bench_support::{open_bench_db, seed_ghosts_db, search_where_prefixed, order_by, Q_NONE, Q_RARE, Q_COMMON}`。

- [ ] **Step 1: bench エントリを Cargo.toml に追加**

`src-tauri/Cargo.toml` 末尾に追記:

```toml
[[bench]]
name = "search_bench"
harness = false
required-features = ["bench"]
```

- [ ] **Step 2: search_bench.rs を実装**

`src-tauri/benches/search_bench.rs`:

```rust
//! SQL 層(search/sort/OFFSET)の計測。cargo bench --features bench --bench search_bench

use std::time::Duration;

use criterion::{BenchmarkId, Criterion};
use ghost_launcher_lib::bench_support::{
    open_bench_db, order_by, search_where_prefixed, seed_ghosts_db, Q_COMMON, Q_NONE, Q_RARE,
};
use rusqlite::Connection;

const RK: &str = "bench-rk";
const LIMIT: i64 = 50;
// 本番 GHOST_SELECT_COLUMNS_PREFIXED と同じ 18 列（materialize コストを再現）
const SELECT_COLS: &str = "g.name, g.sakura_name, g.kero_name, g.craftman, g.craftmanw, \
    g.directory_name, g.path, g.source, g.name_lower, g.sakura_name_lower, g.kero_name_lower, \
    g.craftman_lower, g.craftmanw_lower, g.directory_name_lower, g.thumbnail_path, \
    g.thumbnail_use_self_alpha, g.thumbnail_kind, g.ghost_identity_key";

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
    let where_c = search_where_prefixed();
    // EXPLAIN QUERY PLAN は未束縛 ? を嫌うため、リテラル値で組む（プランは値非依存で SCAN/index が判る）。
    let where_lit = where_c.replace("LIKE ?", "LIKE '%さくら%'");
    let shapes: Vec<(&str, String)> = vec![
        ("empty+name", format!("SELECT {SELECT_COLS} FROM ghosts g WHERE g.request_key='{RK}' ORDER BY {} LIMIT 50", order_by("name"))),
        ("like+name", format!("SELECT {SELECT_COLS} FROM ghosts g WHERE g.request_key='{RK}' AND ({where_lit}) ORDER BY {} LIMIT 50", order_by("name"))),
        ("empty+recent", format!("SELECT {SELECT_COLS} FROM ghosts g WHERE g.request_key='{RK}' ORDER BY {} LIMIT 50", order_by("recent"))),
        ("empty+frequency", format!("SELECT {SELECT_COLS} FROM ghosts g WHERE g.request_key='{RK}' ORDER BY {} LIMIT 50", order_by("frequency"))),
        ("empty+random", format!("SELECT {SELECT_COLS} FROM ghosts g WHERE g.request_key='{RK}' ORDER BY {} LIMIT 50", order_by("random"))),
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
                "SELECT {SELECT_COLS} FROM ghosts g WHERE g.request_key=? ORDER BY {} LIMIT ?",
                order_by(sort)
            );
            group.bench_with_input(BenchmarkId::new("empty_sort", sort), &sql, |b, sql| {
                b.iter(|| run_select(&conn, sql, rusqlite::params![RK, LIMIT]));
            });
        }

        // LIKE 選択率 3 種（sort=name 固定。params: [rk, like×6, limit]）
        for (label, like) in [("none", &like_none), ("rare", &like_rare), ("common", &like_common)] {
            let sql = format!(
                "SELECT {SELECT_COLS} FROM ghosts g WHERE g.request_key=? AND ({where_c}) \
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
                "SELECT {SELECT_COLS} FROM ghosts g WHERE g.request_key=? ORDER BY {} LIMIT ? OFFSET ?",
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
            "SELECT {SELECT_COLS} FROM ghosts g WHERE g.request_key=? AND ({where_c}) \
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
```

> `Guard` の一時ディレクトリ名は `tag`（`plan` / `n1000` / `n10000` / `n100000`）＋ `std::process::id()` で一意化する。`seeded_readonly_db` が呼び出し毎に異なる tag を渡すため、同一プロセス内でも衝突しない。

- [ ] **Step 3: ベンチが起動確認モードで通ることを確認**

Run: `cargo bench --manifest-path src-tauri/Cargo.toml --features bench --bench search_bench -- --test`
Expected: `EXPLAIN QUERY PLAN` が出力され、各ベンチが1回ずつ実行されてエラーなく終了。query plan で `like` 系が `SCAN`、`empty+name` が `USING INDEX idx_ghosts_request_key_name_lower`、`recent`/`frequency`/`random` が `SCAN`＋`USE TEMP B-TREE FOR ORDER BY` になることを目視確認。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/benches/search_bench.rs
git commit -m "$(cat <<'EOF'
test: SQL層 search/sort/OFFSET の criterion ベンチを追加

空/LIKE 3種/sort 4種/OFFSET 3深度/COUNT+SELECT併走を N∈{1k,10k,100k}で
計測し、各形状の EXPLAIN QUERY PLAN を出力する。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: FS tree generator

一時ディレクトリに N 個の `{dir}/ghost/master/descript.txt` を生成し、一部に `shell/master/surface0.png` と Shift_JIS descript を混ぜる。ghost-meta の文字コード判定・thumbnail 解決経路を踏ませる。

**Files:**
- Modify: `src-tauri/src/bench_support.rs`
- Test: `src-tauri/src/bench_support.rs`

**Interfaces:**
- Consumes: `encoding_rs::SHIFT_JIS`（src-tauri の workspace 依存）。
- Produces: `pub fn generate_ghost_tree(ssp_root: &std::path::Path, n: usize) -> Result<std::path::PathBuf, String>` — `{ssp_root}/ghost` 配下に N 体を生成し `ssp_root` を返す。

- [ ] **Step 1: 失敗するテストを書く**

`mod tests` に追加:

```rust
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
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --features bench bench_support::tests::generate`
Expected: FAIL（`generate_ghost_tree` 未定義）。

- [ ] **Step 3: generator を実装**

`bench_support.rs` に追加:

```rust
use std::fs;

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
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --features bench bench_support::tests`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/bench_support.rs
git commit -m "$(cat <<'EOF'
test: FS走査層ベンチ用のゴーストツリー生成器を追加

N 体の実ツリーを生成し、一部に Shift_JIS descript と surface0.png を混ぜて
文字コード判定・thumbnail 解決経路を踏ませる。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: scan/store ラッパーと opaque ハンドル

FS 走査層ベンチが本番 `scan_ghosts_with_fingerprint_internal` / `store_ghosts` / `check_parent_mtimes_match` を叩くための薄い pub ラッパーを用意する。`Ghost`（非 pub 型）は opaque ハンドルで隠蔽する。

**Files:**
- Modify: `src-tauri/src/bench_support.rs`
- Test: `src-tauri/src/bench_support.rs`

**Interfaces:**
- Consumes: `crate::commands::ghost::{scan_ghosts_with_fingerprint_internal, collect_parent_mtimes, check_parent_mtimes_match, store::store_ghosts}`。
- Produces:
  - `pub struct ScannedGhosts`（opaque。フィールド非公開）
  - `pub fn scan_to_handle(ssp_path: &str) -> Result<(ScannedGhosts, String), String>`
  - `pub fn store_handle(conn: &Connection, request_key: &str, h: &ScannedGhosts, fp: &str) -> Result<usize, String>`
  - `pub fn store_with_real_mtimes(conn: &Connection, request_key: &str, h: &ScannedGhosts, fp: &str, ssp_path: &str) -> Result<usize, String>`（layer1 hit を真に成立させるセットアップ用）
  - `pub fn full_scan_count(ssp_path: &str) -> Result<usize, String>`
  - `pub fn layer1_hit(conn: &Connection, request_key: &str, ssp_path: &str) -> bool`

- [ ] **Step 1: 失敗するテストを書く**

`mod tests` に追加:

```rust
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
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --features bench bench_support::tests::scan_to_handle`
Expected: FAIL（未定義）。

- [ ] **Step 3: ラッパーを実装**

`bench_support.rs` に追加:

```rust
use crate::commands::ghost::{
    check_parent_mtimes_match, collect_parent_mtimes, scan_ghosts_with_fingerprint_internal,
};
use crate::commands::ghost::store::store_ghosts;

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

/// Layer 1 高速パス（親 mtime 一致判定）を測る。事前に store_with_real_mtimes で
/// 保存していれば true（hit）、store_handle で保存していれば false（miss）を返すが、
/// 計測対象の「1 行 SELECT + 文字列比較」コストはどちらも同等。
pub fn layer1_hit(conn: &Connection, request_key: &str, ssp_path: &str) -> bool {
    let mtimes = collect_parent_mtimes(ssp_path, &[]);
    check_parent_mtimes_match(conn, request_key, &mtimes)
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --features bench bench_support::tests`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/bench_support.rs
git commit -m "$(cat <<'EOF'
test: FS走査/storeベンチ用の opaque ハンドルとラッパーを追加

scan_to_handle/store_handle/full_scan_count/layer1_hit で本番経路を叩き、
非pub の Ghost 型を ScannedGhosts で隠蔽する。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: scan_bench（FS 走査層 criterion ベンチ）

生成済みツリーに対しフル走査・Layer1 hit・初回 store・差分 store を N∈{1k,10k,100k} で計測。100k は sample を絞る。

**Files:**
- Create: `src-tauri/benches/scan_bench.rs`
- Modify: `src-tauri/Cargo.toml`（`[[bench]]` エントリ）

**Interfaces:**
- Consumes: `ghost_launcher_lib::bench_support::{generate_ghost_tree, open_bench_db, scan_to_handle, store_handle, full_scan_count, layer1_hit}`。

- [ ] **Step 1: bench エントリを追加**

`src-tauri/Cargo.toml` 末尾に追記:

```toml
[[bench]]
name = "scan_bench"
harness = false
required-features = ["bench"]
```

- [ ] **Step 2: scan_bench.rs を実装**

`src-tauri/benches/scan_bench.rs`:

```rust
//! FS走査層(scan/fingerprint/store)の計測。cargo bench --features bench --bench scan_bench

use std::path::{Path, PathBuf};
use std::time::Duration;

use criterion::Criterion;
use ghost_launcher_lib::bench_support::{
    full_scan_count, generate_ghost_tree, layer1_hit, open_bench_db, scan_to_handle, store_handle,
    store_with_real_mtimes,
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
```

> `store_initial` の各反復は空 DB を作り直す（`iter_batched` の setup で DB を新規化し、計測本体は store のみ）。ファイル名衝突は単調カウンタで避ける。100k で `store_initial` を毎反復やるとディスクを食うため、100k のみ `sample_size(10)` で抑える（既に上で設定済み）。

- [ ] **Step 3: 起動確認モードで通ることを確認（軽量 N のみ）**

Run: `cargo bench --manifest-path src-tauri/Cargo.toml --features bench --bench scan_bench -- --test scan_n1000`
Expected: `scan_n1000` グループの各ベンチが1回ずつ実行されエラーなく終了。

> 全 N（100k 含む）を `--test` で回すと FS 生成に数分かかる。起動確認は `scan_n1000` フィルタで足りる。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/benches/scan_bench.rs
git commit -m "$(cat <<'EOF'
test: FS走査層 scan/fingerprint/store の criterion ベンチを追加

フル走査/Layer1 hit/初回store/差分ゼロ再store を N∈{1k,10k,100k}で計測。
100k は sample を絞る。フル走査-Layer1hit が1体増減の代償。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: ベースライン数値レポートの実走と記述

両ベンチを実走し、`docs/perf/baseline-100k.md` に N×形状の数値・query plan 抜粋・所見・実行手順を記す。

**Files:**
- Create: `docs/perf/baseline-100k.md`

**Interfaces:**
- Consumes: `search_bench` / `scan_bench` の実行結果。

- [ ] **Step 1: search_bench を実走して数値を採取**

Run: `cargo bench --manifest-path src-tauri/Cargo.toml --features bench --bench search_bench 2>&1 | tee /tmp/search_bench.txt`
（Windows Git Bash では `tee` 利用可。scratchpad 配下に出力しても可。）
Expected: `EXPLAIN QUERY PLAN` と各グループの中央値が出力される。100k の `like`/`empty_sort recent|frequency|random`/`offset deep` が `name`/index 経路より桁で遅いことを確認。

- [ ] **Step 2: scan_bench を実走して数値を採取**

Run: `cargo bench --manifest-path src-tauri/Cargo.toml --features bench --bench scan_bench 2>&1 | tee /tmp/scan_bench.txt`
Expected: `full_scan` が `layer1_hit`（<1ms 想定）より桁で遅いこと、N に対しほぼ線形に伸びることを確認。100k は sample=10 で indicative 値。

- [ ] **Step 3: レポートを記述**

`docs/perf/baseline-100k.md` を作成する。**実走で得た実数値**を各表に埋める（下記はテンプレート。`…` は実測値で置換すること。空欄・TBD を残さない）:

````markdown
# 性能ベースライン（10万体規模）

- 計測日: <YYYY-MM-DD>
- 目的: 修正の優先順位を実測で決めるためのベースライン。修正は本数値を根拠に別サイクル。

## 実行環境

- OS / CPU コア数 / **ディスク種別（SSD/HDD）** / ビルドプロファイル(release)
- 数値はディスク種別・ページキャッシュ温度で大きく動く。SQL 層は warm-cache 定常状態、FS 層は cold/warm を明記。

## 実行手順

```bash
cargo bench --manifest-path src-tauri/Cargo.toml --features bench --bench search_bench
cargo bench --manifest-path src-tauri/Cargo.toml --features bench --bench scan_bench
```

## SQL 層（search_bench）

### EXPLAIN QUERY PLAN（n=1000）

```
empty+name:  <SEARCH ghosts USING INDEX idx_ghosts_request_key_name_lower ...>
like+name:   <SCAN ghosts ...>
empty+recent:    <SCAN ... USE TEMP B-TREE FOR ORDER BY>
empty+frequency: <SCAN ... USE TEMP B-TREE FOR ORDER BY>
empty+random:    <SCAN ... USE TEMP B-TREE FOR ORDER BY>
```

### レイテンシ中央値

| 形状 | n=1k | n=10k | n=100k |
|---|---|---|---|
| empty_sort/name | … | … | … |
| empty_sort/recent | … | … | … |
| empty_sort/frequency | … | … | … |
| empty_sort/random | … | … | … |
| like/none | … | … | … |
| like/rare | … | … | … |
| like/common | … | … | … |
| offset/0 | … | … | … |
| offset/mid | … | … | … |
| offset/deep | … | … | … |
| count_plus_select_common | … | … | … |

## FS 走査層（scan_bench）

| 形状 | n=1k | n=10k | n=100k(indicative) |
|---|---|---|---|
| full_scan | … | … | … |
| layer1_hit | … | … | … |
| store_initial | … | … | … |
| store_rescan_nodiff | … | … | … |

**フル走査 − Layer1 hit = 1 体増減で払う代償**: <n=100k での差分>

## 所見（修正は別サイクル・推奨のみ）

- 検索: like/* が index 経路(name)に対し n=100k で <倍率>。先頭ワイルドカードが index を無効化。→ FTS5 or 前方一致の検討。
- 全走査: full_scan が layer1_hit に対し <倍率>。NTFS 親 mtime 粒度ゆえ 1 体増減で全走査。→ fingerprint 粒度細分化 or 進捗 UI/streaming。
- ソート: recent/frequency/random が name に対し <倍率>（TEMP B-TREE 全ソート）。→ (request_key, launch_count) 等の複合 index。
- OFFSET: offset/deep が offset/0 に対し <倍率>。→ keyset ページング。

推奨優先順位: <数値に基づく順位>。
````

- [ ] **Step 4: 全体の回帰確認**

Run:
```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
npm test
npm run build
```
Expected: feature 無効の通常ビルド・テストが全 PASS（本番 API 不変）。TS パリティテスト含む vitest が PASS。

- [ ] **Step 5: Commit**

```bash
git add docs/perf/baseline-100k.md
git commit -m "$(cat <<'EOF'
docs: 10万体規模の性能ベースライン数値を記録

search_bench/scan_bench の実走結果(N×形状のレイテンシ・EXPLAIN QUERY PLAN)
と所見を固める。修正の優先順位を数値で根拠づける起点資料。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 実装後の確認（PR 前）

- `/commit` チェックリスト全パス（Task 8 Step 4 でコード系ゲートを実行済み。ベンチは CI 必須にしない）。
- `git status` clean。
- 全フェーズ完了後に一括で PR を作成する（`/pr`）。修正 PR は本 PR マージ後、`docs/perf/baseline-100k.md` の数値を根拠に別途起票。
