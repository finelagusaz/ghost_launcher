---
name: sqlite-tuning
description: SQLite のクエリ効率・インデックス設計・PRAGMA 設定をレビューするサブエージェント。DB スキーマ変更やクエリ追加・修正時に使用する。
---

# SQLite チューニングレビュー

`git diff main..HEAD` で変更されたファイルを読み、DB 関連の変更を分析する。

## プロジェクト固有の前提

- ghosts.db はキャッシュ DB（再スキャンで復旧可能）
- 書き込み: rusqlite 経由の差分 UPSERT（`store_ghosts` in `store.rs`）
- 読み込み: tauri-plugin-sql（sqlx）経由の SELECT（`ghostDatabase.ts`）
- PRAGMA: WAL モード、busy_timeout、synchronous=NORMAL（rusqlite 側）、optimize=0x10002（sqlx 側）
- マイグレーション: sqlx ベース。既存マイグレーション SQL は絶対に編集不可（SHA-384 チェックサム検証）

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

### 4. マイグレーション安全性
- 新規マイグレーションの SQL 構文が正しいか
- `DEFAULT` 値にリテラルのみ使用しているか（関数は不可）
- 既存マイグレーションを変更していないか（チェックサム不一致でクラッシュ）
- `\n` で改行を明示しているか（raw 改行 + インデントは禁止）

### 5. 差分 UPSERT パターン
- `store_ghosts` の INSERT/UPDATE/DELETE 最小化ロジックが壊れていないか
- `ghost_identity_key` の構成（NFKC(source) + `\x1f` + NFKC(directory_name)）が変更されていないか
- `row_fingerprint`（9 フィールドの SHA-256）の対象フィールドに変更がないか

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
