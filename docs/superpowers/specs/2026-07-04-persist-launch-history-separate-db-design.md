# 永続テーブル分離設計（user-data.db）— issue #93

## 背景と壊れている不変条件

`ghosts.db` は「揮発キャッシュだから再スキャンで復旧できる」という前提で、マイグレーション競合時に**ファイルごと削除**して回復する設計になっている（`sanitize_ghost_db` / `reset_ghost_db`）。しかし migration 11 で**永続テーブル `ghost_launches`（起動履歴）が同じ DB ファイルに同居**して以降、この前提は崩れている。

- 削除経路は 2 つあり、どちらも `GHOST_DB_FILES`（ghosts.db + WAL/SHM）を丸ごと消す:
  - 起動時 `sanitize_ghost_db`（Rust, `lib.rs`）— `has_migration_conflict` 検出時、プラグイン起動前に直接 `remove_file`
  - 実行時 `initializeDb` の catch（JS, `ghostDatabase.ts`）— migration エラー → `reset_ghost_db` invoke → 再 load
- リセットのたびに起動履歴が不可逆に失われる。履歴は recent / frequency ソート（F-11）の基盤データである。

**回復すべき不変条件**: 「キャッシュのリセットは永続的なユーザーデータを一切失わせない」。

## 設計方針

永続データと揮発データの**運命共有（fate-sharing）を器のレベルで解消**する。`ghost_launches` を新しい DB ファイル `user-data.db` へ移し、`ghosts.db` を純粋キャッシュへ戻す。これにより「ghosts.db は丸ごと消して安全」という回復戦略が再び真になる。

### なぜ ATTACH による cross-DB JOIN を採らないか

現状の recent / frequency ソートは `ghosts` と `ghost_launches` を SQL の JOIN で結合し、仮想スクロールのため DB 側で `ORDER BY … LIMIT/OFFSET` ページングしている。テーブルを別ファイルに移すと JOIN には `ATTACH DATABASE` が要るが、`tauri-plugin-sql`（sqlx）は `Pool::connect` による**複数接続プール**を使い、`select`/`execute` は毎回 `pool.fetch_all`/`pool.execute` でプールから接続を都度取得する（`wrapper.rs` 実装で確認済み）。したがって `ATTACH` を実行した接続と後続 JOIN クエリの接続が一致せず、**ATTACH が揮発して JOIN が壊れる**。ATTACH 依存は棄却する。

## アーキテクチャ

### 器と所有権

- **`user-data.db`（新設・Rust 専有）** — `ghost_launches` の唯一の住処。**JS からは一切アクセスしない**。Rust の rusqlite 単一接続だけが読み書きする。ghosts.db 用の sqlx プールと無関係なので ATTACH 揮発問題を根本回避する。
  - スキーマは Rust の `CREATE TABLE IF NOT EXISTS`（＋インデックス）で冪等に用意する。sqlx マイグレーション系に載せない。永続ストアなので「マイグレーション競合 → 自動削除」の事故クラスがそもそも発生し得ない構造にする。
- **`ghosts.db`** — 純粋キャッシュに戻る。sanitize / reset は今のまま丸ごと削除してよい。**永続データがここに居ないから安全**、が回復した不変条件。

パス解決は既存の単一権威 `db_path.rs` に `user-data.db` 用ヘルパーを追加して集約する。

### JOIN の代替：非正規化した集計列

recent / frequency の cross-DB JOIN を廃止し、`ghosts` キャッシュへ導出列を 2 本持たせる:

```sql
ALTER TABLE ghosts ADD COLUMN last_launched TEXT;               -- NULL 既定
ALTER TABLE ghosts ADD COLUMN launch_count  INTEGER NOT NULL DEFAULT 0;
```

`buildOrderBy` の JOIN は消え、`ORDER BY g.last_launched DESC NULLS LAST, g.name_lower`（recent）/ `ORDER BY g.launch_count DESC, g.name_lower`（frequency）という**単一 DB のプレーンな ORDER BY** になる。

**この選択の理由:**

- 読み取り経路が全ソートモードで一様に保たれ、仮想スクロールのページング（`LIMIT/OFFSET`）が無傷。代替案（recent/frequency だけ Rust rusqlite+ATTACH でライブ JOIN してページを返す）は、18 列の `GHOST_SELECT_COLUMNS` 単一権威を Rust 側へ二重実装させ、fixture で守ってきたドリフト防御を壊す。
- 集計列は**再導出可能な導出キャッシュ**。ghosts が消えても user-data.db から作り直せるので、キャッシュの性格と矛盾しない。

**意味的等価性**: 集計は `ghost_identity_key` 単位。同一 identity が複数 request_key に跨って現れても、`UPDATE ghosts … WHERE ghost_identity_key=?` が全該当行を揃って更新するため、現行 JOIN（`ON g.ghost_identity_key = gl.ghost_identity_key`、request_key 非依存）と等価。

### 集計列の維持

- **`record_launch(ghost_identity_key)` を Rust コマンド化** — ① user-data.db へ `INSERT`、② ghosts.db の該当行を `launch_count = launch_count + 1, last_launched = <now>` に `UPDATE`。JS の `recordLaunch` は `invoke("record_launch", …)` の薄いラッパーへ縮退する。
- **スキャン時バックフィル** — `scan_and_store`（既に rusqlite）でキャッシュ再構築後、user-data.db の集計（`MAX(launched_at)`, `COUNT(*)` を `ghost_identity_key` で GROUP BY）を読み、ghosts の集計列へ書き戻す。単一の制御された接続なのでここでは ATTACH も安全（あるいは 2 本の rusqlite 接続で読み→書き）。バックフィルは periodic な reconciliation として働き、recordLaunch の +1 近似を権威値へ収束させる。

### 一度きりのデータ移送

旧 `ghosts.db.ghost_launches` の履歴を、初回起動時に user-data.db へ複写する冪等ステップ（Rust）。

- 実行タイミング: 起動時 setup（JS の `Database.load` がマイグレーションを走らせる前）。Rust setup は JS load より先に走ることを確認済み。
- 手順: user-data.db スキーマを用意 → ghosts.db に `ghost_launches` テーブルが存在すれば行を user-data.db へ複写。
- 冪等性: 複写後、旧テーブルは migration で DROP される（下記）。DROP 後は複写元が存在しないため再実行されない。
- 旧テーブルの除去は**新規マイグレーション**（migration 11 は不変のまま、後続の追加マイグレーションで `DROP TABLE ghost_launches`）で行い、ghosts.db のスキーマ管理をマイグレーション系に保つ。DROP は移送より後に走る（Rust setup → JS load 順の保証）。

### スキーマ変更の一覧（ghosts.db, マイグレーション追加）

- 追加 A: `ALTER TABLE ghosts ADD COLUMN last_launched TEXT; ALTER TABLE ghosts ADD COLUMN launch_count INTEGER NOT NULL DEFAULT 0;`
- 追加 B: `DROP TABLE IF EXISTS ghost_launches;`（データ移送後に実行される）

（正確な version 番号と SQL 文字列は実装計画で確定する。`\n` 明示・リテラル DEFAULT の作法を厳守。）

## エラーハンドリング

- user-data.db を開けない / 作れない場合: 起動を阻害しない。履歴機能は degrade する（集計列は NULL/0 のままなので、recent/frequency は実質すべて未起動として name 順に並ぶ。専用フォールバック分岐は不要）。ログに warn を残す。
- データ移送の失敗: warn ログのみ。次回起動で再試行（旧テーブル未 DROP なら再試行される）。
- record_launch の失敗: 現状と同じく fire-and-forget（起動体験を阻害しない）。

## テスト（TDD）

- **Rust**
  - リセット（reset_ghost_db / sanitize 相当）後も user-data.db の履歴が残存する（回復した不変条件の直接検証）。
  - `record_launch` が user-data.db への INSERT と ghosts.db 集計列 UPDATE の二面更新を行う。
  - バックフィルが user-data.db の集計から ghosts の集計列を再導出する。
  - 一度きり移送の冪等性（複写済み／複写元なしで no-op）。
- **TypeScript**
  - `recordLaunch` が `record_launch` を invoke する（sspClient のモック契約）。
  - `buildOrderBy` が recent/frequency で JOIN を持たず、集計列で ORDER BY する。

## ドキュメント整合

- `src/lib/ghostDatabase.ts` の「キャッシュ DB なので再スキャンで復旧可能」コメント、`src-tauri/CLAUDE.md` の同旨記述を、分離後の正しい記述へ更新。
- `SPEC.md` §4.5（永続テーブルのキー設計）・§13（マイグレーション自動回復）・§6.x（DB 層）を新構成へ同期。

## スコープ外（YAGNI）

- `favorites` 等の将来の永続テーブルは本 issue では作らない。ただし user-data.db という器が用意されることで、追加時に運命共有の再発を防げる素地となる。
- user-data.db のスキーマバージョニング機構は導入しない（現状 1 テーブル）。将来の破壊的変更が必要になった時点で最小の仕組みを足す。
