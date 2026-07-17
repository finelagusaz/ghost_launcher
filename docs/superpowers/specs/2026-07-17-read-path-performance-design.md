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

スキーマ変更＝全ユーザー自動リビルド（受容済みトレードオフ）のため、物理変更は 1 回の改訂に束ねてリビルド回数を 1 回にする。検索方式は §4.1 のとおり実測で確定済み（LIKE 系維持・`instr` ＋ `search_text` 同乗 index。FTS5 不採用）。実測記録は `docs/perf/2026-07-17-candidate-search-shapes.md`。

- **派生列 `search_text` の追加**: 検索 6 列（`_lower` 群）を `\x1f`（ユーザーが入力し得ない区切り）で連結した WHERE 専用列。Rust 書込側（store）が単一権威として導出する。SELECT 投影（`GHOST_VIEW_COLUMNS`・共有 fixture）には含めない
- **検索述語を `instr(search_text, ?) > 0` へ**: JS の `searchGhosts` / `countGhostsByQuery` の 6 列 LIKE OR を置換する。LIKE の `%`/`_` メタ文字非エスケープ問題も同時に消える
- **ソート複合 index（search_text 同乗）**: `(request_key, name_lower, search_text)`（既存 `(request_key, name_lower)` を置換）・`(request_key, last_launched DESC, name_lower, search_text)`・`(request_key, launch_count DESC, name_lower, search_text)` を追加。search_text の同乗により、検索×ソートでプランナが index 上で instr を評価し（非マッチ行の本体 seek なし・LIMIT 件のマッチで早期終了・ヒント不要）、素朴なソート index 追加で起きる sort-first 劣化（実測 229〜339ms）を避ける。SQLite は NULL を最小と扱い DESC で末尾に置くため、既存の `DESC NULLS LAST` は index 順序とそのまま適合する（#136 の分岐 2 つはこれで解ける）
- **冗長 index 削除**: `idx_ghosts_request_key` は複合 index 群の prefix に包含されており削除する（UPSERT の書込コストも下がる）
- **parity テストの退役**: これが使い捨てスキーマ初のスキーマ変更リリースになるため、src-tauri/CLAUDE.md の取り決めどおり `cache_schema.rs` の parity テストと `lib.rs` の旧 `migrations()` を同一 PR で削除する
- **検索入力のデバウンス（JS・スキーマ無関係）**: キー入力毎のクエリ発行をデバウンス/in-flight 合流で削減する（Phase 1 の発行規律の続き。スキーマと独立のため同 Phase 内の別コミットでよい）

受け入れ: 本番スキーマで検索（全ソート・全クエリ長）が 10万体で数 ms〜20ms 台前半（旧 6 列 LIKE 比 約 15 倍）、`empty_sort/recent`・`frequency` が `name` と同桁（µs 台）へ、EXPLAIN QUERY PLAN から `USE TEMP B-TREE FOR ORDER BY` が消える（random は式ソートのため対象外）。DB サイズ増と store 系 bench（書込コスト）の増分を計測して記録する。**→ 実測済み**: `docs/perf/2026-07-17-candidate-search-shapes.md`「Phase 2 検収実測」（EXPLAIN ガードは `cache_schema.rs` のテストへ常設・検索形状は `search_bench` の `search`/`search_recent` として常設）。

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

### 4.1 検索方式（決定済み: LIKE 系維持＋instr＋search_text 同乗 index。FTS5 不採用）

Phase 2 着手時の実測（`docs/perf/2026-07-17-candidate-search-shapes.md`・ユーザー裁定 2026-07-17）で確定した。

- **実測根拠**: 現行 6 列 LIKE の 10万体最悪 305.6ms（0 件マッチ）が、search_text 同乗 index ＋ instr で 16.8ms（約 18 倍）。検索×recent ソートも 9.9〜16.4ms。改善の主因は「カバリング index 上でフィルタが完結し、非マッチ行の幅広テーブル行 seek が消える」ことであり、連結列単体は効果ゼロ（現行と誤差レベル）と分離検証済み
- **FTS5 不採用の理由**: trigram は 3 文字未満のクエリに効かず LIKE へフォールバックする。日本語ゴースト名は 1〜2 文字検索が現実的に多く、インクリメンタル検索の最初の 1〜2 打鍵は必ずこの fallback を通るため、体感の入口を改善できない。同乗 index 方式は**全クエリ長・全ソート**に効き、external content テーブル＋トリガー同期の複雑さ（本体と index の乖離という新規バグクラス）も負わない
- **#135 の扱い**: Phase 2 完了時に「LIKE 系維持＋同乗 index で対処」としてクローズする

### 4.2 リビルドの束ね方

Phase 2 以外はスキーマ不変。将来スキーマ変更を追加する判断になった場合（FTS5 の再検討を含む）も、他のスキーマ変更と束ねて 1 リビルドにする（`CACHE_SCHEMA` 変更のたびに全ユーザーがフルスキャン再投入を払うため）。

## 5. 不変条件

- **IPC 契約不変**: `scan_and_store`・`record_launch`・`cleanup_ghost_caches` の引数・戻り値は全フェーズで不変（`/ipc-check` 対象外の見込みだが各フェーズで確認）
- **NFKC 正規化パリティ**: 検索キーは JS `normalizeForKey` と Rust `ghost_identity_key` の既存パリティを維持。`search_text` は既存 `_lower` 列の連結として導出するため、パリティは列側で維持される
- **集計列の権威**: `ghost_launches`（user-data.db）が権威、`ghosts` の集計列は導出キャッシュ——この関係は Phase 3 後も不変
- **`GHOST_VIEW_COLUMNS` 網羅**: SELECT 投影は全フェーズで不変（fixtures 機械照合の対象）

## 6. テスト戦略

- 各フェーズ TDD（/implement）。検収は `search_bench`/`scan_bench` の該当形状（Phase 0 で CI ガード済みのハーネス）
- Phase 1: vitest（COUNT 非発行・空クエリ SQL 形状）＋ bench 形状追加
- Phase 2: EXPLAIN QUERY PLAN 検証（`cache_schema.rs` のテストに常設・`search_bench` の `search`/`search_recent` 形状で計測）・parity テスト退役
- Phase 3: Layer 1 経路の GROUP BY 非発行テスト・#93 回帰ガード維持
- 検索 UI に触れるフェーズの完了時は `/e2e` を一巡（正常水準 10 passed / 1 skipped）

## 7. スコープ外

- スキャン層の追加最適化（FS 監視 / ReadDirectoryChangesW による walk 削減）— 別 issue 候補として記録済み（メモリ）
- `cargo bench` 実走の CI 組み込み・性能回帰ゲート（#133 設計書から引き続きスコープ外)
- random ソートの index 化（式ソートのため原理的に不可・全フェーズで対象外）
