# 読み経路性能設計書（epic #140）

10万体規模ベースライン（`docs/perf/baseline-100k.md`・PR #133）を検収基準に、読み経路（検索・ソート・ページング・集計）の性能問題を段階修正する。個別 issue（#135 #136 #137 #138 #139 #156）を 2 つの根本軸に束ね、フェーズ分けで独立マージ可能に進める。

## 1. 目的と背景

epic #140 の残 4 issue（#135〜#137 ＋ハーネス保守 #138/#139）に、課題分析（2026-07-17）で新規発見した #156（backfill の毎回実行）を加えて一括設計する。issue 起票時から前提が 2 つ変わった:

- **#146 の使い捨てスキーマで migration 制約が消滅**。#135/#136 の「注意」欄（sqlx チェックサム不変性）は化石。index・FTS5 テーブル・派生列の追加は `CACHE_SCHEMA` の直接編集 1 回で全ユーザーへ自動リビルド配布される
- **FTS5 は利用可能**。`libsqlite3-sys 0.30.1` bundled は `SQLITE_ENABLE_FTS5` 付きでコンパイルされ（build.rs で確認済み）、SQLite 3.46 系のため trigram トークナイザ（3.34+）も使える。rusqlite（writer）と sqlx（reader）は同一バイナリを共有する

## 2. 課題の構造（2 軸）

### 軸 A: 物理設計とクエリ形状の不一致

「どの読みが速くあるべきか」から逆算した物理構造がない。EXPLAIN 実測（baseline-100k.md）で:

- recent/frequency ソート → `SCAN g` + `USE TEMP B-TREE FOR ORDER BY`（対応 index なし・#136）
- 先頭ワイルドカード LIKE → `request_key` 絞り込み後の行ごと残余フィルタ（#135 の半分）
- `ORDER BY RANDOM() LIMIT 1`（`getRandomGhost`）→ パーティション全走査＋全件ソート

### 軸 B: クエリ発行規律の欠如（増幅）

「いつ・何回発行するか」の設計がない。index を足しても解けない:

- `searchGhosts` が**全フェッチで COUNT を併走**（`useSearch` はスクロールの各ページでも `searchGhosts` を呼ぶ）。total が変わるのはリセット時（requestKey/query/sort/epoch 変更）のみなのに、~90ms（10万体・LIKE COUNT）がキー入力毎＋ページ毎に再発行される。**#135 の体感の過半はこの増幅**
- `backfill_aggregates` が Layer 1 高速パス含む全スキャン経路で毎回走る（#156。O(全起動履歴) GROUP BY ＋ユニーク起動ゴースト数の個別 UPDATE）
- 空クエリのページフェッチが `LIKE '%%'` を検索列すべてに対して行ごとに評価する（`searchGhosts` に空クエリ分岐がない）
- `hasGhosts` が COUNT(*) 全数（EXISTS で 1 行観測に置換可能）

## 3. フェーズ構成（各フェーズ独立マージ可能・上から順）

### Phase 0: 検収ハーネスの CI ガード（#138・#139）

本工事の検収道具（`cargo bench --features bench`）を先に CI 監視下へ置く。

- `ci-build.yml` へ 2 ステップ追加: `cargo check --features bench --benches`（signature ドリフト検出）と `cargo test --features bench --lib bench_support`（SQL 形状パリティ等のガード実行）。`cargo bench` 実走は入れない
- `search_bench` の `SELECT_COLS` 手書きリテラルを `src/test/fixtures/ghost-view-columns.json` 連動へ置換（投影ドリフトの機械検出）
- **CI 変更 → `/commit` チェックリスト突合**（/implement の引き金表）: bench 系ゲートは CI のみとし、ローカルチェックリストへは追加しない（実行コストと発火頻度の均衡。この非対称は意図的と `/commit` 側に明記する）

受け入れ: CI が bench のコンパイル・ガードテストを実行し、`SELECT_COLS` を故意にドリフトさせると CI が落ちること。

### Phase 1: クエリ発行規律（スキーマ不変・JS のみ）

- **COUNT の発行をリセット時 1 回に限定**: `searchGhosts` から COUNT 併走を外し、`useSearch` が isReset のときだけ `countGhostsByQuery` を発行する（total は state に保持済み）。スクロールページは SELECT のみになる
- **空クエリ分岐**: `searchGhosts` は正規化後クエリが空なら LIKE 節なしの SQL を発行する
- **`hasGhosts` を EXISTS 化**: `SELECT EXISTS(SELECT 1 FROM ghosts WHERE request_key = ?)`
- **`getRandomGhost` の RANDOM() 廃止**: パーティション件数を取り `LIMIT 1 OFFSET (乱数 % 件数)` に置換（COUNT は request_key index の index-only scan・OFFSET は単発操作なので許容）

受け入れ: vitest で「スクロールによる offset 変更時に COUNT が発行されない」「空クエリの SQL に LIKE が含まれない」を担保。`search_bench` へ select-only ページフェッチ形状を追加し、`count_plus_select` との差を記録。

### Phase 2: 物理設計改訂（CACHE_SCHEMA 1 回の改訂に束ねる・#136 ＋ #135 の残り）

スキーマ変更＝全ユーザー自動リビルド（受容済みトレードオフ）のため、物理変更は 1 回の改訂に束ねてリビルド回数を 1 回にする。

- **ソート複合 index 追加**: `(request_key, last_launched DESC, name_lower)` と `(request_key, launch_count DESC, name_lower)`。SQLite は NULL を最小と扱い DESC で末尾に置くため、既存の `DESC NULLS LAST` は index 順序とそのまま適合する（#136 の分岐 2 つはこれで解ける。tie-break の `name_lower` も index に含めて完全 index-ordered にする）
- **冗長 index 削除**: `idx_ghosts_request_key` は複合 index 群の prefix に包含されており削除する（UPSERT の書込コストも下がる）
- **検索方式の決定ゲート（§4.1）**: FTS5 導入時はこの改訂に同梱する
- **parity テストの退役**: これが使い捨てスキーマ初のスキーマ変更リリースになるため、src-tauri/CLAUDE.md の取り決めどおり `cache_schema.rs` の parity テストと `lib.rs` の旧 `migrations()` を同一 PR で削除する

受け入れ: `search_bench` の `empty_sort/recent`・`frequency` が `name` と同桁（~30µs 台）へ、EXPLAIN QUERY PLAN から `USE TEMP B-TREE FOR ORDER BY` が消える（random は式ソートのため対象外・現状維持）。

### Phase 3: backfill の経路限定（#156）

推奨案 B: `backfill_aggregates` の呼び出しを cache miss（`apply_scan_delta` 実行後）のみに限定し、Layer 1/Layer 2 hit 経路から外す。

- 集計列（`last_launched`/`launch_count`)の平常時の権威ある更新経路は `record_launch_inner` の即時 bump（既存）
- backfill の healing 責務は「リビルド後の集計復元」（issue #93 回帰ガード・cache miss 経路に残る）と「record_launch の ghosts 側 UPDATE 失敗の修復」（次の cache miss まで遅延することを受容する。集計列は導出キャッシュで、ズレの実害は並び順のみ）
- 案 A（高水位差分）は管理列の追加が必要で、案 B で頻度が「実書込時のみ」に落ちれば全量再導出でも許容範囲のため採らない（YAGNI）。案 C（単一文化）は案 B 実施後の実測で必要なら追加

受け入れ: Layer 1 hit 経路で `ghost_launches` への GROUP BY が発行されないことをユニットテストで担保。`アップグレードのリビルドを通じて起動履歴が保持され集計へ再導出される`（launch_history.rs の既存回帰ガード）が引き続き green。

### Phase 4: keyset ページング（#137）— 再判定ゲート

最低優先。Phase 1〜3 のマージ後に実測で要否を再判定する:

- Phase 1 で COUNT 増幅が消えると、深いページのコストは SELECT 単発の OFFSET（10万体で ~4ms）のみになる。体感閾値（1 フレーム 16ms）を下回るなら**意図的スキップとして #137 をクローズ**する
- 実施する場合: sort 種別ごとの境界キー（name→`name_lower`、recent/frequency→集計列＋tie-break）で `WHERE (sort_key, tie) > (?, ?)` 方式。random（式ソート）は keyset でも TEMP B-TREE が残るため対象外のまま。`useSearch` のバッファ縫合（offset 前提）の載せ替えが必要で、`/symmetry-check`・`/cache-check` 対象

## 4. 設計判断

### 4.1 検索方式（Phase 2 の決定ゲート）

Phase 1 完了後に残る検索コストは「キー入力毎の SELECT（LIKE 残余フィルタ）1 回」= 10万体実測で 42〜117ms/回。選択肢:

| 案 | 効果 | コスト・制約 |
|---|---|---|
| LIKE 維持（Phase 1 のみ） | 実装ゼロ。現実規模（数千体）では ~1ms 未満で十分 | 10万体では 1 キー入力 40ms 超が残る |
| trigram FTS5 | substring 検索を index 化（10万体でも ms 級） | **3 文字未満のクエリには効かず LIKE 同等へフォールバック**（日本語ゴースト名は 1〜2 文字検索が現実的にありうる）。検索列を連結した external content テーブル＋トリガー同期を CACHE_SCHEMA に追加。NFKC 正規化パリティは既存 `_lower` 列を原文に使えば維持 |
| 前方一致へ割り切り | 既存 index で即解決 | 中間一致 UX の喪失（受容しがたい） |

**判定基準**: 対象規模の裁定に従う。epic #140 は「10万体規模」を明示スコープとするため既定は trigram FTS5 だが、#134 の教訓（多秒フリーズは 10万体合成のみ・現実規模は桁違いに軽い）を踏まえ、**Phase 2 着手時の brainstorm で「1〜2 文字クエリの実頻度」と「LIKE フォールバックの許容」をユーザーと確認して確定**する。FTS5 を見送る場合、#135 は「Phase 1（増幅解消）で対処・index 化は意図的スキップ」として理由付きクローズする。

### 4.2 リビルドの束ね方

Phase 2 以外はスキーマ不変。FTS5 を後から足す判断になった場合も、他のスキーマ変更と束ねて 1 リビルドにする（`CACHE_SCHEMA` 変更のたびに全ユーザーがフルスキャン再投入を払うため）。

## 5. 不変条件

- **IPC 契約不変**: `scan_and_store`・`record_launch`・`cleanup_ghost_caches` の引数・戻り値は全フェーズで不変（`/ipc-check` 対象外の見込みだが各フェーズで確認）
- **NFKC 正規化パリティ**: 検索キーは JS `normalizeForKey` と Rust `ghost_identity_key` の既存パリティを維持。FTS5 導入時も index の原文は既存 `_lower` 列から導出する
- **集計列の権威**: `ghost_launches`（user-data.db）が権威、`ghosts` の集計列は導出キャッシュ——この関係は Phase 3 後も不変
- **`GHOST_VIEW_COLUMNS` 網羅**: SELECT 投影は全フェーズで不変（fixtures 機械照合の対象）

## 6. テスト戦略

- 各フェーズ TDD（/implement）。検収は `search_bench`/`scan_bench` の該当形状（Phase 0 で CI ガード済みのハーネス）
- Phase 1: vitest（COUNT 非発行・空クエリ SQL 形状）＋ bench 形状追加
- Phase 2: EXPLAIN QUERY PLAN 検証（bench_support の既存パリティガードへ形状を追加）・parity テスト退役
- Phase 3: Layer 1 経路の GROUP BY 非発行テスト・#93 回帰ガード維持
- 検索 UI に触れるフェーズの完了時は `/e2e` を一巡（正常水準 10 passed / 1 skipped）

## 7. スコープ外

- スキャン層の追加最適化（FS 監視 / ReadDirectoryChangesW による walk 削減）— 別 issue 候補として記録済み（メモリ）
- `cargo bench` 実走の CI 組み込み・性能回帰ゲート（#133 設計書から引き続きスコープ外)
- random ソートの index 化（式ソートのため原理的に不可・全フェーズで対象外）
