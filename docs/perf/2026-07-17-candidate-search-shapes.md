# 検索改善候補の計測記録（#135/#136・Phase 2 設計根拠）

- 計測日: 2026-07-17
- 実行環境: AMD Ryzen 7 8840U / Windows 11 Home / 約 24 GB
  - `baseline-100k.md` のベースライン表とは**別マシン**。絶対値の比較が有効なのは本文書内・同一 run 内のペア差のみ
- ハーネス: `search_bench` の `cand_*` group（`cargo bench --features bench --bench search_bench -- 'cand_'`）
  - 候補 DDL（`search_text` 連結列・各種 index）は **bench の一時 DB にのみ適用**し、本番 `CACHE_SCHEMA` は不変のまま比較した
- 目的: LIKE 維持を前提にした検索改善候補（連結列・instr・カバリング index・ソート index 同乗）の効果を分離測定し、Phase 2 の物理設計を実測で確定する

## 候補 DDL

```sql
ALTER TABLE ghosts ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
UPDATE ghosts SET search_text = name_lower || char(31) || sakura_name_lower || char(31)
  || kero_name_lower || char(31) || craftman_lower || char(31)
  || craftmanw_lower || char(31) || directory_name_lower;
-- 変種 1: 検索カバリング index
CREATE INDEX idx_cand_search_cover ON ghosts(request_key, name_lower, search_text);
-- 変種 2: ソート index（素朴形）
CREATE INDEX idx_cand_recent ON ghosts(request_key, last_launched DESC, name_lower);
-- 変種 3: ソート index（search_text 同乗形）
CREATE INDEX idx_cand_recent_cover ON ghosts(request_key, last_launched DESC, name_lower, search_text);
```

`_lower` 列は全て `NOT NULL DEFAULT ''` のため COALESCE 不要。区切りの `char(31)`（`\x1f`）はユーザーが入力し得ない文字で、列境界をまたぐ偽ヒットを防ぐ。

## 計測 1: 検索形状（sort=name・n=100k・中央値）

| 形状 | none（0 件・最悪） | common |
|---|---|---|
| like6_wide（現行 6 列 LIKE） | 305.6 ms | 186.9 ms |
| instr1_concat_noidx（連結列のみ・index なし） | 300.8 ms | 185.3 ms |
| like1_concat（連結列＋カバリング index・LIKE） | 19.1 ms | 11.2 ms |
| instr1_concat（連結列＋カバリング index・instr） | 16.8 ms | 10.5 ms |
| instr1_cover_subq（＋副問い合わせで id 先絞り） | 15.6 ms | 9.9 ms |

n=10k では like6_wide 25.1/15.7 ms に対し候補群は概ね 0.7〜1.3 ms。

**EXPLAIN QUERY PLAN（要点）**:

- like6_wide / instr1_concat_noidx: `SEARCH g USING INDEX idx_ghosts_request_key_name_lower (request_key=?)` — パーティション全行の**幅広テーブル行 seek** を伴う残余フィルタ
- like1_concat / instr1_concat: `SEARCH g USING INDEX idx_cand_search_cover (request_key=?)` — WHERE の search_text を **index 上で評価**し、マッチ行のみ本体 seek

## 計測 2: 検索×ソート（sort=recent・n=100k・中央値）

| 形状 | none | common |
|---|---|---|
| empty_recent（検索なし・ソート index あり） | **61.9 µs** | — |
| search_recent（変種 1+2 共存・プランナ任せ） | 339.4 ms | 228.9 ms |
| search_recent_filter_first（INDEXED BY で強制） | 14.9 ms | 40.8 ms |
| search_recent_sort_first（INDEXED BY で強制） | 357.0 ms | 226.1 ms |
| **search_recent_ridealong（変種 3・プランナ任せ）** | **16.4 ms** | **9.9 ms** |

**EXPLAIN QUERY PLAN（要点）**:

- 変種 1+2 共存時のプランナ選択: `SEARCH g USING INDEX idx_cand_recent (request_key=?)` — **sort-first を選び**、recent 順に幅広行を seek しながら述語評価する遅い経路
- 変種 3: `SEARCH g USING INDEX idx_cand_recent_cover (request_key=?)` — 同乗 index を自発的に選び、index 上で instr 評価・LIMIT 件のマッチで早期終了（ヒント不要）

## 結論（Phase 2 設計への入力）

1. **改善の主因はカバリング index 上でフィルタが完結すること**。連結列単体は現行と誤差レベル（コストの支配項は述語評価でなく非マッチ行の幅広テーブル行 seek）
2. **ソート index の素朴な追加は検索×ソートを劣化させる**（プランナが sort-first を選ぶ）。`search_text` をソート index 末尾に同乗させると検索×ソートも 10〜17ms に収まり、INDEXED BY 等のヒントが不要
3. instr は LIKE 比 ~7% 改善に加え、`%`/`_` メタ文字の非エスケープ問題を解消する
4. 副問い合わせ形状の追加改善は ~6% で複雑さに見合わず不採用
5. trigram FTS5 は不要: 同乗 index 方式が**全クエリ長（1〜2 文字含む）・全ソート**で 10万体 10〜17ms を達成する

## 未計測（Phase 2 実装時の宿題）

- 本番スキーマ適用後の DB サイズ増（`PRAGMA page_count` 比較）と store 系 bench（UPSERT・リビルド書込コスト）の再計測
- 検索×random（式ソートのため TEMP B-TREE 残置。filter-first 相当の十数〜数十 ms と見込むが未実測）
