# 10万体規模の性能計測ハーネス 設計書

- 日付: 2026-07-16
- 種別: テスト基盤 / 性能計測ハーネス（常設）
- 前提: `main` から派生ブランチ（`feature/perf-benchmark-harness`）で実装する。本 spec は **計測基盤とベースライン数値の取得までがスコープ**であり、**修正（FTS5 化・fingerprint 粒度細分化・複合 index・keyset ページング等）は対象外**。修正は本ハーネスが吐いた数字を根拠に、別サイクルで個別に設計・実装する。

## 背景

10 万体規模でどこがボトルネックになるかを、コード読解から 4 局面の仮説として立てた（`src-tauri/src/commands/ghost/`・`src/lib/ghostDatabase.ts` の実測読解に基づく）。

1. **部分一致検索（定常状態・タイプ毎）**: `searchGhosts`（`src/lib/ghostDatabase.ts:260`）は `%query%`（先頭ワイルドカード、`:250`）を 6 列 OR（`:187`）で評価する。先頭 `%` は B-tree index を無効化するため、request_key パーティションの全行フルスキャン。さらに `Promise.all`（`:269`）で COUNT と SELECT の 2 クエリが走る。
2. **初回＝全走査スキャン（cold start・1 体増減毎）**: `scan_and_store`（`src-tauri/src/commands/ghost/mod.rs:33`）は Layer 1 で親ディレクトリ mtime を照合（`:55`, `fingerprint.rs:103`、hit なら <1ms）。ミス時は Layer 2 で `scan_ghosts_with_fingerprint_internal`（`scan.rs:193`）が全ゴーストを歩き直し、各件で `read_ghost`（`ghost.rs:31`、descript.txt を 2 回パース＋ thumbnail 解決）。NTFS の親 mtime はゴースト 1 体の追加・削除で変化する（`mod.rs:50` のコメント）ため、**catalog を触るたびに Layer 1 ミス→全走査**が蘇る。差分 UPSERT（`store.rs`）が節約するのは DB 書き込みのみで、fingerprint 再計算のための FS 全走査は丸ごと走る。
3. **特殊ソート（recent/frequency/random 選択時）**: `buildOrderBy`（`ghostDatabase.ts:212`）の `name` は `idx_ghosts_request_key_name_lower`（`lib.rs:30`）に乗るが、`recent`（`last_launched`）・`frequency`（`launch_count`）は migration 12（`lib.rs:90`）が列追加のみで index 未張り、`random` は式ソートで index 不可。いずれも毎ページ全ソート。
4. **スクロール（深い OFFSET のみ）**: `useVirtualizedList` は DOM を O(窓) に抑える（描画は非問題）が、フェッチは OFFSET ページング（`ghostDatabase.ts:272`）で O(offset)。上記 2・3 を OFFSET 越しに増幅する。

**この仮説は「コード読解」であって「実測」ではない。** 修正の優先順位を推測で決めるのは本末転倒であり、まず N を振った数値と `EXPLAIN QUERY PLAN` で裏を取る。

## 決定

- **A. 二層計測ハーネスを常設する。** SQL 層（search/sort/OFFSET）と FS 走査層（scan/fingerprint/store）を、criterion ベンチ＋共有フィクスチャ生成器で計測する。E2E は対象外。
- **B. ベースライン数値レポートをコミットする。** N×計測形状の表と query plan 抜粋を人間可読の markdown に固め、修正サイクルの起点資料にする。
- **C. 修正は数字を見てから別サイクルで決める。** 本 spec では一切修正しない。

設計原則: **推測ではなく実測で修正を選ぶ。計測基盤は再現可能な回帰ガードとして常設する（使い捨てにしない）。**

## 計測の faithfulness（なぜ Rust / criterion か）

- アプリ本番の SQL 経路は sqlx（`tauri-plugin-sql`）だが、rusqlite と **同一 libsqlite3 を共有する**（`links = "sqlite3"` 制約、`src-tauri/CLAUDE.md` 記載）。ゆえに rusqlite + criterion の SQL 計測は、本番が支払うエンジンコスト（index 選択・LIKE スキャン・ソート・OFFSET）を忠実に反映する。TS 層の IPC / デシリアライズ差分は本スコープ外（それは FS/E2E 層の関心事）。
- criterion は sqlite にリンクしない純 Rust の dev-dependency。`libsqlite3-sys` 共有制約（`src-tauri/CLAUDE.md`）に影響しない。

## A. 二層計測ハーネス

### A-1. 共有フィクスチャ生成器（lib 内・`bench` feature で pub 露出）

`src-tauri/src/bench_support.rs` を新設し、`lib.rs` に `#[cfg(feature = "bench")] pub mod bench_support;` を追加する。ベンチ（外部クレート扱い）から `ghost_launcher_lib::bench_support::*` として参照する。同 feature で以下も pub 露出する（現在 `pub(crate)`）:

- `migrations()`（`lib.rs`）— seeder がスキーマ適用に使う。
- `commands::ghost` の `scan_ghosts_with_fingerprint_internal`・`store::store_ghosts`・`store::configure_connection` への薄い pub ラッパー。

いずれも `#[cfg(feature = "bench")]` ガード下でのみ pub になり、本番ビルド（feature 無効）では可視性・API は不変。

**seeder（SQL 層・FS 非依存）:**

```rust
/// 一時ファイル DB に migrations を適用し、N 行の合成ゴーストを 1 トランザクションで投入する。
/// 名前分布は現実寄せ（下記）。単一 request_key パーティションに入れる。
pub fn seed_ghosts_db(conn: &Connection, request_key: &str, n: usize);
```

- 列は `store.rs` の INSERT と一致（`name`/`sakura_name`/…/`_lower` 列・`ghost_identity_key`・`row_fingerprint`・`last_launched`・`launch_count`）。`_lower` 列は `normalize_for_key` 相当で生成。
- **現実寄せの分布**（全同一名だと LIKE 選択率が歪み誤誘導する）:
  - 名前: 日本語語彙（例: 「さくら」「ゴースト」+ 連番）と ASCII 語彙を混在。
  - 作者名・sakura.name・kero.name も一定割合で埋める（検索 6 列の実効性を測るため）。
  - `last_launched`/`launch_count`: 一部のみ非 NULL / 非ゼロにばらけさせる（recent/frequency ソートの現実性）。
- **固定シードのクエリセット**（決定的・再現可能）:
  - `q0`: どの行にもマッチしない語（0 件）。
  - `q_rare`: 数十件だけマッチする語。
  - `q_common`: 数千〜万件マッチする語。

**tree generator（FS 走査層）:**

```rust
/// temp（scratchpad）配下に N 個の {dir}/ghost/master/descript.txt を生成する。
/// 一定割合に shell/master/surface0.png を置き thumbnail 解決経路も測る。
/// 戻り値は生成した ssp ルート（{root}/ghost を親に持つ）。
pub fn generate_ghost_tree(root: &Path, n: usize) -> PathBuf;
```

- descript.txt は現実的な UTF-8 内容（`charset,UTF-8` / `name,...` / `craftman,...` / `sakura.name,...`）。
- Shift_JIS の descript を一定割合混ぜ、`crates/ghost-meta` の文字コード判定経路も踏む。

### A-2. ベンチ入口（criterion）

`Cargo.toml` に追加:

```toml
[features]
bench = []

[dev-dependencies]
criterion = "…"   # 実装時に cargo info で最新安定を確認しピン留め

[[bench]]
name = "search_bench"
harness = false
required-features = ["bench"]

[[bench]]
name = "scan_bench"
harness = false
required-features = ["bench"]
```

実行は `cargo bench --features bench`。各ベンチは `harness = false` の **カスタム `fn main()`** とし、順序は「① 代表形状の `EXPLAIN QUERY PLAN` を stdout に出力 → ② criterion 計測グループ」。criterion は `Criterion::default().configure_from_args()` を手動駆動する。

**`search_bench`（SQL 層）:** 一時ファイル DB を **本番の読み取り接続 `loadDb`（`ghostDatabase.ts:35`）と同じ PRAGMA**（`journal_mode=WAL`・`busy_timeout`・`journal_size_limit`・`optimize`）で開き、`seed_ghosts_db` で N 行投入。書き込み用 `configure_connection`（`store.rs`、`cache_size=-65536`・大 mmap）は**引かない**——検索は本番では sqlx の読み取り接続上で走るため、書き込み側の大 cache を積むと 100k スキャンが本番より速く出て数字が甘くなる。cache 依存の差はレポートに注記する。DB はグループ開始前に 1 回だけ構築し、計測クロージャ内は SELECT のみ（seeding を計測に含めない）。criterion は多数反復でページキャッシュが温まるため、計測値は「タイプ中の warm-cache 定常状態」を表す旨も注記する。N∈{1k, 10k, 100k}。計測形状:

| 形状 | クエリ | 検証したい事実 |
|---|---|---|
| 空クエリ | WHERE request_key=? ORDER BY name_lower LIMIT | index 経路の基準値 |
| LIKE 0 件 | `q0` を 6 列 OR LIKE | フルスキャンの下限コスト |
| LIKE 希少 | `q_rare` | スキャン + 少数ソート |
| LIKE 多数 | `q_common` | スキャン + 多数ソート |
| sort=name | ORDER BY name_lower | index-ordered top-N |
| sort=recent | ORDER BY last_launched DESC | 全ソート（index 無し） |
| sort=frequency | ORDER BY launch_count DESC | 全ソート（index 無し） |
| sort=random | ORDER BY (id*seed)%mod | 式ソート（index 不可） |
| OFFSET 0 / 中 / 深 | LIMIT ? OFFSET {0, N/2, N-limit} | O(offset) の可視化 |
| COUNT+SELECT 併走 | `Promise.all` 相当の 2 クエリ合算 | 本番 1 検索の実コスト |

各形状で `EXPLAIN QUERY PLAN` を 1 回出力し、`SCAN` か `SEARCH ... USING INDEX` かを証拠として記録する。

**`scan_bench`（FS 走査層）:** `generate_ghost_tree` で N 個のツリーを 1 回生成し（計測外）、以下を計測。N∈{1k, 10k, 100k}。100k は `sample_size(10)` に絞り indicative 値とする（各サンプルが数秒〜数十秒）。

| 形状 | 対象 | 検証したい事実 |
|---|---|---|
| フル走査 | `scan_ghosts_with_fingerprint_internal` | Layer 2 全走査 = 1 体増減毎に蘇るコスト |
| Layer 1 hit | `check_parent_mtimes_match` | 無変更時の <1ms 高速パス |
| 初回 store | `store_ghosts`（既存 0 行→N INSERT） | 初回全挿入の書き込みコスト |
| 差分 store | `store_ghosts`（既存 N 行→1 行差分） | 差分 UPSERT の実コスト |

**フル走査 vs Layer 1 hit の差分が「1 体の追加・削除で払う代償」の実測値**である旨をレポートに明記する。

### A-3. 生成器の単体テスト

`bench_support` に小さな単体テスト（`#[cfg(test)]`、feature ゲート下）:
- `seed_ghosts_db(_, _, n)` 後の行数が n。
- `_lower` 列が `normalize_for_key` の出力と一致（既存 `normalize-key-cases.json` 流儀に整合）。
- `generate_ghost_tree(_, n)` が n 個の descript.txt を持つツリーを作る。
- クエリセット `q_rare`/`q_common` の実マッチ件数が意図した桁（希少/多数）に収まる。

## B. ベースライン数値レポート

`docs/perf/baseline-100k.md` を新設・コミット。内容:
- 実行環境（OS・CPU コア数・**ディスク種別**・ビルドプロファイル）。数値はディスク種別で大きく動くため必須明記。
- SQL 層: N×形状の中央値レイテンシ表 ＋ `EXPLAIN QUERY PLAN` 抜粋。
- FS 層: N×形状の表（100k は indicative）＋「フル走査 − Layer1 hit」の差分。
- 所見: 4 局面仮説のどれが数値で裏付いたか、修正の優先順位（推奨のみ・実装は別サイクル）。

レポートの数値取得は実装フェーズ（`cargo bench --features bench` の実走）で埋める。本 spec ではテンプレートと項目を確定する。

## C. 既知の留意点（設計上の傷）

- **SQL 文字列の複製ドリフト**: ベンチは検索の WHERE / ORDER BY を再現するが、真の権威は `ghostDatabase.ts`（`GHOST_SEARCH_WHERE`・`buildOrderBy`）。対策として、リポジトリ既存の「共有フィクスチャで言語間パリティを縛る」流儀（`src/test/fixtures/normalize-key-cases.json`）に倣い、**SQL 形状（WHERE テンプレート・各 ORDER BY 式）を `src/test/fixtures/search-sql-shapes.json` に切り出し、TS 側パリティテストとベンチの双方が参照する**。これによりベンチの計測対象が本番クエリ形状からずれれば TS テストが Red になる。
- **`bench` feature の pub 露出**: FS 層ベンチは実 crate 関数を測るため `pub(crate)` を最小限 pub に上げる。feature ガードで本番 API は不変に保つ。
- **FS 生成コスト**: 100k ツリーは Windows NTFS で ~30〜50 万小ファイル・数分・数 GB。scaling curve（1k→10k→100k）で O(n) を可視化し、100k は sample を絞る。生成先は scratchpad の temp（`TempDirGuard` 流儀で確実削除）、**非コミット**。

## テスト方針

- 生成器: A-3 の単体テスト（feature ゲート下、`cargo test --features bench`）。
- パリティ: `search-sql-shapes.json` を TS 側テスト（vitest）とベンチ双方が参照。
- ベンチ自体はテストではないため CI 必須にはしない（実走が重く不安定なため）。最小確認として `cargo bench --features bench -- --test`（criterion の 1 回だけ実行モード）が壊れず通ること。
- 本番ビルド不変: feature 無効の `cargo check` / `cargo build` が従来通り（公開 API・可視性が変わらない）。

## スコープ外（YAGNI）

- **修正の実装全般**（FTS5 化、fingerprint 粒度細分化、`(request_key, launch_count)` 等の複合 index、keyset ページング、スキャンの streaming / 進捗 UI）。数字を見てから別サイクル。
- E2E / 実アプリ体感計測（WebView + IPC）。今回は SQL 層と FS 走査層に限定。
- TS 層の IPC / デシリアライズオーバーヘッド計測。
- CI へのベンチ組み込み・性能回帰の自動 gate。ハーネスは常設するが、閾値による自動失敗は別件。

## PR 構成

A（生成器＋ベンチ入口）・A-3（生成器テスト）・B（レポートテンプレート＋実走数値）・C のパリティ fixture は、いずれも「計測基盤の新設」で一貫するため **単一 PR**。レポートの数値埋めは同 PR 内の実走で行う。修正 PR は本 PR マージ後、数値を根拠に別途起票する。

## 却下した代替案

- **TS/vitest bench で本番関数を直接叩く**: SQL 文字列の複製を避けられる利点はあるが、`getDb()`＝`Database.load` が Tauri 束縛で Node では別物の shim になり忠実性が落ち、かつ FS 走査層（本 spec の対象）を一切測れない。単独では不足。SQL 形状パリティは C の共有 fixture で担保する方が軽い。
- **使い捨て計測（scratchpad で測りコミットしない）**: 身軽だが再現が手作業になり、性能に敏感なこれらの経路の回帰を将来検知できない。「リポジトリに残す」判断に基づき却下。
- **criterion を使わず自前 Instant 計測のみ**: 統計的厳密さ（外れ値除去・信頼区間）を失う。SQL 層の高速クエリは分散が効くため criterion を採る。FS 層の重い 100k のみ sample を絞って併用する。
