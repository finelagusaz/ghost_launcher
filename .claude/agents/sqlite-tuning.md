---
name: sqlite-tuning
description: SQLite のクエリ効率・インデックス設計・PRAGMA 設定をレビューするサブエージェント。DB スキーマ変更やクエリ追加・修正時に使用する。
model: sonnet
effort: medium
tools: Read, Grep, Glob, Bash
---

# SQLite チューニングレビュー

`git diff main..HEAD` で変更されたファイルを読み、DB 関連の変更を分析する。

## プロジェクト固有の前提

- ghosts.db はキャッシュ DB（再スキャンで復旧可能）
- 書き込み: DB アクター（`actor/`）専有スレッドが rusqlite で行う差分書込（`store_ghosts_delta` in `commands/ghost/store.rs`）
- 読み込み: tauri-plugin-sql（sqlx）経由の SELECT（`ghostDatabase.ts`）
- PRAGMA: rusqlite 書込接続の `configure_connection`（WAL・busy_timeout・synchronous=NORMAL 等）。`PRAGMA optimize`／条件付き VACUUM はアクターの `Job::Maintenance`。JS `loadDb()` は busy_timeout のみ
- スキーマ: ghosts.db はマイグレーションを持たない使い捨てスキーマ（`cache_schema.rs` の `CACHE_SCHEMA`。ハッシュ不一致で起動時に全 DROP+CREATE）。user-data.db は `launch_history::ensure_schema` の追加式のみ。詳細は `src-tauri/CLAUDE.md`「SQLite」節

## チェック項目

### 1. クエリ効率
- 新規・変更された SELECT 文に適切なインデックスが存在するか
- `LIKE '%keyword%'` のような先頭ワイルドカード検索が不要に使われていないか
- 不要な `SELECT *` がないか（必要なカラムのみ指定すべき）
- N+1 クエリパターンが発生していないか

### 2. インデックス設計
- 新規インデックスが既存クエリパターンと整合しているか
- カバリングインデックスの活用余地がないか（特に `ghost_identity_key` + `row_fingerprint` パターン）
- 不要なインデックス（INSERT/UPDATE コストだけ増やすもの）がないか

### 3. PRAGMA と接続設定
- rusqlite 側と sqlx 側の PRAGMA 設定に矛盾がないか
- WAL モードの前提が壊れる変更がないか
- `busy_timeout` が適切か（並行アクセスのデッドロック回避）

### 4. スキーマ変更の安全性
- ghosts.db の DDL 変更が `CACHE_SCHEMA` の直接編集で行われているか（アクター外・別経路の DDL を足していないか）
- `CACHE_SCHEMA` の変更は全ユーザーのキャッシュ破棄＋フルスキャン再投入を伴う。そのコストが変更に見合うか
- user-data.db（永続）への変更に `DROP`／`DELETE FROM` が混入していないか（追加式のみ）

### 5. 差分 UPSERT パターン
- `store_ghosts_delta` の INSERT/UPDATE/DELETE 最小化ロジックが壊れていないか
- `ghost_identity_key` の構成（NFKC(source) + `\x1f` + NFKC(directory_name)）が変更されていないか
- `row_fingerprint` の対象フィールドに変更がないか（算出関数は `store.rs` が単一権威）

## 出力形式

問題が見つかった場合:
```
## 🔴 [深刻度: 高/中/低] [カテゴリ]
- **ファイル**: `path/to/file:行番号`
- **問題**: 具体的な説明
- **影響**: パフォーマンス劣化の程度やクラッシュリスク
- **修正案**: 具体的な SQL やコード例
```

問題がない場合:
```
## ✅ SQLite 上の問題なし
確認した観点: [チェックした項目のリスト]
```
