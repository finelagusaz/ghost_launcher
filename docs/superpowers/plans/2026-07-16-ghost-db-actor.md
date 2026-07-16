# GhostDbActor ＋ 使い捨てスキーマ Implementation Plan（issue #146）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ghosts.db への全書き込みを単一 writer スレッド（GhostDbActor）へ集約し、sqlx マイグレーションを PRAGMA user_version ベースの使い捨てスキーマへ置換する。

**Architecture:** アクターは `(ghosts_conn, user_data_conn)` を所有する専有スレッド。コマンドは `Job` を unbounded チャネルへ送り oneshot で応答を待つ薄い皮になる。スキーマは `CACHE_SCHEMA` 1 枚＋そのハッシュ由来の `user_version` で管理し、不一致なら単一トランザクションでリビルドする。

**Tech Stack:** Rust（rusqlite・tokio sync チャネル・std::thread）、Tauri 2、TypeScript（変更は JS 読み取り専用化のみ）。

**設計書（単一権威）:** `docs/superpowers/specs/2026-07-16-ghost-db-actor-design.md`

## Global Constraints

- IPC 契約: `scan_and_store`／`record_launch` の引数・戻り値は**不変**。`reset_ghost_db` は呼び出し元ごと削除。新規は `cleanup_ghost_caches` のみ
- 起動順序の不変条件（設計 §2.1）: sanitize → user-data 初期化＋**legacy 移送** → `ensure_cache_schema` → アクター起動。**移送がリビルドより先**（違反すると永続履歴を破壊）
- リビルドは `BEGIN IMMEDIATE` 単一トランザクション。DROP 対象から `sqlite_%` を除外
- user-data.db は**絶対に DROP しない**（追加式 `ensure_schema` のみ）
- 複数文の書き込みは RAII `Transaction`（`unchecked_transaction` 等）経由。`execute_batch("BEGIN;…")` 禁止（設計 §3.1）
- コードコメントは日本語。migration SQL 文字列はテスト専用化後もバイト不変で温存（parity テストの入力）
- 各タスク末尾のコミットは `/commit` スキルのチェックリスト（docs-only 免除規定含む）に従う
- Rust テスト実行: `cargo test --manifest-path src-tauri/Cargo.toml`（以下 `cargo test` と略記。cwd はリポジトリルート）

## File Structure（最終形）

```
src-tauri/src/
├── cache_schema.rs      # 新規: CACHE_SCHEMA・cache_schema_version()・ensure_cache_schema()・parity テスト
├── actor/
│   ├── mod.rs           # 新規: Job enum・ActorHandle・spawn_actor・run_loop・run_guarded・bootstrap・maintenance
│   └── db_path.rs       # 移動: 旧 src/db_path.rs（pub(super) 化 = 可視性封鎖）
├── lib.rs               # 変更: add_migrations 撤去・migrations() を #[cfg(test)] 化・setup を actor::bootstrap へ
├── testutil.rs          # 変更: apply_all_migrations → apply_cache_schema（CACHE_SCHEMA 適用）
└── commands/
    ├── ghost/mod.rs     # 変更: scan_and_store_blocking を (conn, user_conn) 受け取りに・コマンドはジョブ送信
    ├── launch_history.rs# 変更: record_launch をジョブ送信に・open_user_data_db は bootstrap へ吸収
    └── db.rs            # 削除（reset_ghost_db）
削除: src-tauri/src/scan_coordinator.rs・src-tauri/tests/lock_wiring.rs・
      src-tauri/tests-common-controls-v6.manifest・build.rs の link-arg 節・
      Cargo.toml dev-deps の tauri test feature
新規: clippy.toml（disallowed-methods）
src/lib/ghostDatabase.ts # 変更: initializeDb 簡素化・cleanupOldGhostCaches を invoke 化・loadDb PRAGMA 削減
```

---

# Phase 1: 使い捨てスキーマ

### Task 1: `cache_schema.rs` — CACHE_SCHEMA とリビルド

**Files:**
- Create: `src-tauri/src/cache_schema.rs`
- Modify: `src-tauri/src/lib.rs`（`mod cache_schema;` 追加のみ）

**Interfaces:**
- Produces: `pub(crate) const CACHE_SCHEMA: &str` / `pub(crate) fn cache_schema_version() -> i32` / `pub(crate) fn ensure_cache_schema(conn: &mut rusqlite::Connection) -> Result<(), String>`

- [ ] **Step 1: 失敗するテストを書く**（`cache_schema.rs` 内 `#[cfg(test)]`）

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn user_version(conn: &rusqlite::Connection) -> i32 {
        conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn 初期状態のuser_version_0からリビルドされスキーマとversionが揃う() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        ensure_cache_schema(&mut conn).unwrap();
        assert_eq!(user_version(&conn), cache_schema_version());
        // 主要テーブルが存在する
        for t in ["ghosts", "ghost_fingerprints", "ghost_scan_entries"] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [t],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "{t} が作成されていない");
        }
    }

    #[test]
    fn version一致ならデータを保持しリビルドしない() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        ensure_cache_schema(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO ghost_fingerprints (request_key, fingerprint) VALUES ('rk', 'fp')",
            [],
        )
        .unwrap();
        ensure_cache_schema(&mut conn).unwrap(); // 2 回目は no-op
        let fp: String = conn
            .query_row("SELECT fingerprint FROM ghost_fingerprints WHERE request_key='rk'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fp, "fp");
    }

    #[test]
    fn version不一致なら全ユーザーテーブルを破棄して作り直す() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        // 旧世代を模す: 適当なテーブルと _sqlx_migrations、user_version=0 のまま
        conn.execute_batch(
            "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY);\nCREATE TABLE legacy_junk (x INTEGER);",
        )
        .unwrap();
        ensure_cache_schema(&mut conn).unwrap();
        for t in ["_sqlx_migrations", "legacy_junk"] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [t],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 0, "{t} が破棄されていない");
        }
        assert_eq!(user_version(&conn), cache_schema_version());
    }

    #[test]
    fn cache_schema_versionは0を返さない() {
        assert_ne!(cache_schema_version(), 0, "0 は未初期化の予約値");
    }
}
```

- [ ] **Step 2: 失敗を確認** — Run: `cargo test cache_schema` → Expected: コンパイルエラー（`ensure_cache_schema` 未定義）

- [ ] **Step 3: 実装**

```rust
// cache_schema.rs
//! ghosts.db（揮発キャッシュ）の使い捨てスキーマ管理。
//! マイグレーションを持たない: スキーマは CACHE_SCHEMA 1 枚が単一権威で、
//! その FNV-1a ハッシュを PRAGMA user_version に刻む。不一致＝旧世代 → 全破棄して作り直す
//! （キャッシュは再スキャンで復旧する。設計書 §4）。
//! user-data.db（永続）はこの機構の対象外（launch_history::ensure_schema の追加式のみ）。

use rusqlite::{Connection, TransactionBehavior};

/// 現行スキーマの全定義（旧 sqlx migration 1〜14 の合成結果。parity テストが一致を機械検証する）。
/// 列順は ALTER TABLE の追加順を保存している（PRAGMA table_info の cid 比較を成立させるため）。
pub(crate) const CACHE_SCHEMA: &str = "CREATE TABLE ghosts (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL,\n  directory_name TEXT NOT NULL,\n  path TEXT NOT NULL,\n  source TEXT NOT NULL,\n  name_lower TEXT NOT NULL,\n  directory_name_lower TEXT NOT NULL,\n  request_key TEXT NOT NULL DEFAULT '',\n  updated_at TEXT NOT NULL DEFAULT '',\n  craftman TEXT NOT NULL DEFAULT '',\n  thumbnail_path TEXT NOT NULL DEFAULT '',\n  thumbnail_use_self_alpha INTEGER NOT NULL DEFAULT 0,\n  thumbnail_kind TEXT NOT NULL DEFAULT '',\n  ghost_identity_key TEXT NOT NULL DEFAULT '',\n  row_fingerprint TEXT NOT NULL DEFAULT '',\n  sakura_name TEXT NOT NULL DEFAULT '',\n  kero_name TEXT NOT NULL DEFAULT '',\n  craftmanw TEXT NOT NULL DEFAULT '',\n  sakura_name_lower TEXT NOT NULL DEFAULT '',\n  kero_name_lower TEXT NOT NULL DEFAULT '',\n  craftman_lower TEXT NOT NULL DEFAULT '',\n  craftmanw_lower TEXT NOT NULL DEFAULT '',\n  last_launched TEXT,\n  launch_count INTEGER NOT NULL DEFAULT 0\n);\nCREATE INDEX idx_ghosts_request_key ON ghosts(request_key);\nCREATE INDEX idx_ghosts_request_key_name_lower ON ghosts(request_key, name_lower);\nCREATE INDEX idx_ghosts_request_key_directory_name_lower ON ghosts(request_key, directory_name_lower);\nCREATE INDEX idx_ghosts_request_key_updated_at ON ghosts(request_key, updated_at);\nCREATE UNIQUE INDEX idx_ghosts_request_key_identity ON ghosts(request_key, ghost_identity_key);\nCREATE INDEX idx_ghosts_request_key_identity_fingerprint ON ghosts(request_key, ghost_identity_key, row_fingerprint);\nCREATE TABLE ghost_fingerprints (\n  request_key TEXT PRIMARY KEY,\n  fingerprint TEXT NOT NULL,\n  updated_at TEXT NOT NULL DEFAULT '',\n  parent_mtimes TEXT NOT NULL DEFAULT ''\n);\nCREATE TABLE ghost_scan_entries (\n  request_key TEXT NOT NULL,\n  scan_key TEXT NOT NULL,\n  token TEXT NOT NULL,\n  ghost_identity_key TEXT NOT NULL,\n  PRIMARY KEY (request_key, scan_key)\n) WITHOUT ROWID;";

/// CACHE_SCHEMA 文字列の FNV-1a ハッシュを i32 に畳んだ値（0 は未初期化の予約値なので 1 にずらす）。
/// スキーマ本文の変更＝自動的に version が変わる。手動 bump が存在しないため
/// 「bump 忘れで既存ユーザーだけ silent に壊れる」クラスが構造的に存在しない（設計書 §4）。
pub(crate) fn cache_schema_version() -> i32 {
    let mut h: u32 = 2166136261;
    for b in CACHE_SCHEMA.bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(16777619);
    }
    let v = h as i32;
    if v == 0 { 1 } else { v }
}

/// user_version が現行と一致すればそのまま、不一致なら単一トランザクションでリビルドする。
/// BEGIN IMMEDIATE で writer ロックを先取りするため、WAL の並行 reader は COMMIT まで
/// 旧スナップショットを見続け「no such table」を観測しない。DDL も user_version も
/// トランザクショナルなので、途中クラッシュは旧状態へ自動復元され次回起動で再試行される。
pub(crate) fn ensure_cache_schema(conn: &mut Connection) -> Result<(), String> {
    let current: i32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| format!("user_version 取得エラー: {e}"))?;
    if current == cache_schema_version() {
        return Ok(());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("リビルド開始エラー: {e}"))?;
    // sqlite_% 内部テーブル（sqlite_sequence・sqlite_stat1 等）は DROP 不可のため除外する
    let tables: Vec<String> = {
        let mut stmt = tx
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .map_err(|e| format!("テーブル列挙エラー: {e}"))?;
        stmt.query_map([], |r| r.get(0))
            .map_err(|e| format!("テーブル列挙エラー: {e}"))?
            .filter_map(Result::ok)
            .collect()
    };
    for t in &tables {
        tx.execute_batch(&format!("DROP TABLE \"{t}\""))
            .map_err(|e| format!("{t} の破棄エラー: {e}"))?;
    }
    tx.execute_batch(CACHE_SCHEMA)
        .map_err(|e| format!("スキーマ作成エラー: {e}"))?;
    tx.execute_batch(&format!("PRAGMA user_version = {}", cache_schema_version()))
        .map_err(|e| format!("user_version 設定エラー: {e}"))?;
    tx.commit().map_err(|e| format!("リビルド commit エラー: {e}"))
}
```

`lib.rs` 冒頭のモジュール宣言群に `mod cache_schema;` を追加する。

- [ ] **Step 4: パス確認** — Run: `cargo test cache_schema` → Expected: 4 passed
- [ ] **Step 5: コミット** — `git add src-tauri/src/cache_schema.rs src-tauri/src/lib.rs` → `feat: 使い捨てスキーマ ensure_cache_schema を追加（#146 Phase1）`

### Task 2: parity テスト（旧 migration 合成との一致検証）

**Files:**
- Modify: `src-tauri/src/cache_schema.rs`（tests に追記）

**Interfaces:**
- Consumes: `crate::migrations()`（現行 `pub(crate)`。Task 3 で `#[cfg(test)]` 化されるがシグネチャ不変）

- [ ] **Step 1: 失敗するテストを書く**（`cache_schema.rs` の tests に追記）

```rust
    /// DDL テキストの正規化: IF NOT EXISTS・引用符・空白差を吸収する。
    /// COLLATE・CHECK・部分インデックス述語は PRAGMA に現れないため、
    /// 構造比較（下）とこのテキスト比較の二段構えで一致を検証する（設計書 §8）。
    fn normalize_ddl(sql: &str) -> String {
        sql.replace("IF NOT EXISTS ", "")
            .replace('"', "")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .replace("( ", "(")
            .replace(" )", ")")
            .replace(" ,", ",")
            .replace(", ", ",")
    }

    /// (種別, 名前) → 正規化 DDL。自動生成物（sqlite_% と PK の自動インデックス）は除外。
    fn schema_objects(conn: &rusqlite::Connection) -> std::collections::BTreeMap<(String, String), String> {
        let mut stmt = conn
            .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL")
            .unwrap();
        stmt.query_map([], |r| {
            Ok(((r.get::<_, String>(0)?, r.get::<_, String>(1)?), r.get::<_, String>(2)?))
        })
        .unwrap()
        .filter_map(Result::ok)
        .map(|(k, sql)| (k, normalize_ddl(&sql)))
        .collect()
    }

    /// テーブル毎の table_info（cid,name,type,notnull,dflt,pk）の一覧
    fn table_infos(conn: &rusqlite::Connection, table: &str) -> Vec<(i32, String, String, i32, Option<String>, i32)> {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info(\"{table}\")")).unwrap();
        stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    /// 最大リスクの機械検証（設計書 §8）: CACHE_SCHEMA と旧 migration 15 本の合成結果が
    /// 完全一致すること。このテストの寿命はスキーマを初めて変更するリリースまで
    /// （その時点で旧 migrations() ごと削除する）。
    #[test]
    fn cache_schemaは旧migration合成とスキーマが完全一致する() {
        // 旧: migration を順番に全適用
        let legacy = rusqlite::Connection::open_in_memory().unwrap();
        let mut migs = crate::migrations();
        migs.sort_by_key(|m| m.version);
        for m in &migs {
            legacy.execute_batch(m.sql).unwrap();
        }
        // 新: CACHE_SCHEMA を適用
        let mut fresh = rusqlite::Connection::open_in_memory().unwrap();
        ensure_cache_schema(&mut fresh).unwrap();

        // 第一段: 正規化 DDL テキストの全オブジェクト比較
        assert_eq!(
            schema_objects(&legacy),
            schema_objects(&fresh),
            "sqlite_master の DDL（正規化後）が一致しない"
        );
        // 第二段: 構造比較（列の型・NOT NULL・DEFAULT・順序）
        for table in ["ghosts", "ghost_fingerprints", "ghost_scan_entries"] {
            assert_eq!(
                table_infos(&legacy, table),
                table_infos(&fresh, table),
                "{table} の table_info が一致しない"
            );
        }
    }
```

- [ ] **Step 2: 実行して結果を確認** — Run: `cargo test cache_schemaは旧migration合成`
  Expected: PASS（Task 1 の CACHE_SCHEMA が正しければ）。**FAIL の場合が本テストの存在意義**: assert の diff 出力を読み、`CACHE_SCHEMA` を旧合成に一致するまで修正する（旧 migration 側は絶対に変更しない）
- [ ] **Step 3: コミット** — `test: CACHE_SCHEMA と旧 migration 合成の一致を機械検証（#146 Phase1）`

### Task 3: 起動配線の切替（sqlx migration 撤去・最小 sanitize・順序確立）

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/testutil.rs`
- Modify: `src-tauri/src/commands/launch_history.rs`（アップグレードテストの改修）

**Interfaces:**
- Produces: `testutil::apply_cache_schema(conn: &rusqlite::Connection)`（旧 `apply_all_migrations` の後継。全テスト用 DB 初期化の単一ヘルパー）
- Consumes: `cache_schema::ensure_cache_schema`（Task 1）

- [ ] **Step 1: testutil を書き換える**（利用側 7 箇所は機械置換）

```rust
/// 現行キャッシュスキーマを適用する（テスト用 DB 初期化の単一ヘルパー）。
/// 旧 apply_all_migrations の後継。migration 由来ではなく CACHE_SCHEMA が単一権威。
pub(crate) fn apply_cache_schema(conn: &rusqlite::Connection) {
    conn.execute_batch(crate::cache_schema::CACHE_SCHEMA)
        .unwrap_or_else(|e| panic!("cache schema の適用に失敗: {e}"));
}
```

`apply_all_migrations` を削除し、呼び出し 7 箇所（`lib.rs`×3・`commands/ghost/mod.rs`×2・`commands/launch_history.rs`×2）を `apply_cache_schema` へ置換する。`commands/ghost/mod.rs` の `open_file_ghost_db` の has_schema 分岐はそのまま（`crate::testutil::apply_cache_schema(&conn)` を呼ぶ）。

- [ ] **Step 2: lib.rs の migration 系を整理する**

1. `migrations()` の直前に `#[cfg(test)]` を付ける（**SQL 文字列はバイト不変**・doc コメントに「parity テスト専用。スキーマ初変更時に cache_schema のテストごと削除する」と追記）
2. builder から `.plugin(tauri_plugin_sql::Builder::default().add_migrations(...))` を `.plugin(tauri_plugin_sql::Builder::default().build())` に変更（プラグイン自体は JS の SELECT 用に残す）
3. `sanitize_ghost_db` を最小化・`has_migration_conflict` を削除:

```rust
/// ghosts.db が破損して open 不能なら関連ファイルごと削除する（webview ロード前なので競合なし）。
/// スキーマ検査は不要になった: 使い捨てスキーマは ensure_cache_schema が version 不一致で
/// 自動リビルドするため、「マイグレーション競合」という事故クラス自体が存在しない。
fn sanitize_ghost_db(app: &tauri::App) {
    let Ok(db_dir) = db_path::ghost_db_dir(app) else {
        return;
    };
    let db_path = db_dir.join(db_path::GHOST_DB_FILES[0]);
    if !db_path.exists() {
        return;
    }
    let ok = rusqlite::Connection::open(&db_path)
        .and_then(|c| c.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0)))
        .is_ok();
    if !ok {
        for filename in db_path::GHOST_DB_FILES {
            let _ = std::fs::remove_file(db_dir.join(filename));
        }
    }
}
```

4. setup を順序不変条件（設計 §2.1）どおりに:

```rust
        .setup(|app| {
            sanitize_ghost_db(app);
            init_user_data(app); // legacy 移送を含む。ensure より先が不変条件（設計書 §2.1）
            if let Err(e) = init_cache_schema(app) {
                eprintln!("[cache-schema] 初期化に失敗しました: {e}");
            }
            Ok(())
        })
```

```rust
/// ghosts.db を開いて使い捨てスキーマを確定させる（webview ロード前・同期）。
/// Phase 2 でアクター構築（actor::bootstrap）へ吸収される予定の暫定配線。
fn init_cache_schema(app: &tauri::App) -> Result<(), String> {
    let path = db_path::ghost_db_path(app)?;
    let mut conn =
        rusqlite::Connection::open(&path).map_err(|e| format!("ghosts.db オープンエラー: {e}"))?;
    commands::ghost::store::configure_connection(&conn)?;
    cache_schema::ensure_cache_schema(&mut conn)
}
```

5. `has_migration_conflict` のテスト群（`全マイグレーション適用済みなら競合なし` と take(3)/take(6) 系の競合テスト）を削除。`ghost_viewの全選択列がghostsスキーマに存在する` は `apply_cache_schema` ベースへ置換。`マイグレーションが順番にインメモリdbへ適用できる`・`migration12と13で…` は migration が cfg(test) になっても動くため温存（parity テストの入力の健全性検査を兼ねる）

- [ ] **Step 3: launch_history のアップグレードテストを新方式へ改修**（設計 §9 の legacy 順序回帰ガード）

`アップグレードとリセットを通じて起動履歴が保持され集計へ再導出される` を以下に置換する（migration 12/13 適用の段を「リビルド」に、リセットの fs 削除の段を「再リビルド」に差し替え。**移送 → リビルドの順序が本体**）:

```rust
    // 旧世代（migration 1..=11 の ghosts.db・履歴同居）からのアップグレードで、
    // legacy 移送 → ensure_cache_schema（全 DROP リビルド）の順序により
    // 永続履歴が保持され集計へ再導出されることを検証する（設計書 §2.1/§9・issue #93/#146）。
    #[test]
    fn アップグレードのリビルドを通じて起動履歴が保持され集計へ再導出される() {
        let dir = crate::testutil::TempDirGuard::new("ghost_launcher_upgrade_rebuild_test");
        let ghosts_path = dir.path().join("ghosts.db");
        let user_path = dir.path().join("user-data.db");

        // 旧バージョン再現: migration 1..=11 のみ適用し、ghost 行 + 起動履歴 2 件を投入
        {
            let conn = Connection::open(&ghosts_path).unwrap();
            let mut migs = crate::migrations();
            migs.sort_by_key(|m| m.version);
            for m in migs.iter().filter(|m| m.version <= 11) {
                conn.execute_batch(m.sql).unwrap();
            }
            insert_ghost_row(&conn, "sspg");
            for at in ["2026-01-01 00:00:00", "2026-01-02 00:00:00"] {
                conn.execute(
                    "INSERT INTO ghost_launches (ghost_identity_key, launched_at) VALUES ('sspg', ?1)",
                    rusqlite::params![at],
                )
                .unwrap();
            }
        }

        // 起動シーケンス（設計書 §2.1 の順序）: (2) legacy 移送 → (3) リビルド
        {
            let user_conn = Connection::open(&user_path).unwrap();
            ensure_schema(&user_conn).unwrap();
            let ghosts_conn = Connection::open(&ghosts_path).unwrap();
            migrate_legacy_launch_history(&ghosts_conn, &user_conn).unwrap();
            let n: i64 = user_conn
                .query_row("SELECT COUNT(*) FROM ghost_launches", [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 2, "旧履歴が user-data.db へ移送される");
        }
        {
            let mut conn = Connection::open(&ghosts_path).unwrap();
            crate::cache_schema::ensure_cache_schema(&mut conn).unwrap(); // user_version=0 → 全 DROP リビルド
            let has_legacy: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='ghost_launches'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(has_legacy, 0, "リビルドで旧テーブルは消える（移送済みなので安全）");
        }

        // 再スキャン相当: 行再投入 + backfill → 集計が移送済み履歴から復元される
        {
            let conn = Connection::open(&ghosts_path).unwrap();
            insert_ghost_row(&conn, "sspg");
            let user_conn = Connection::open(&user_path).unwrap();
            backfill_aggregates(&conn, &user_conn).unwrap();
            let (c, last): (i64, Option<String>) = conn
                .query_row(
                    "SELECT launch_count, last_launched FROM ghosts WHERE ghost_identity_key='sspg'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(c, 2, "リビルド後も user-data.db の履歴から集計が復元される");
            assert_eq!(last.as_deref(), Some("2026-01-02 00:00:00"));
        }
    }
```

- [ ] **Step 4: 全テスト実行** — Run: `cargo test` → Expected: all pass（削除したテスト分は減る）
- [ ] **Step 5: コミット** — `feat: sqlx migration を撤去し ensure_cache_schema へ切替（#146 Phase1）`

### Task 4: `reset_ghost_db` と JS 回復パスの撤去

**Files:**
- Delete: `src-tauri/src/commands/db.rs`
- Modify: `src-tauri/src/lib.rs`（`pub use commands::db::reset_ghost_db;` と invoke_handler の行・`mod` 宣言側 `commands/mod.rs` の `pub mod db;` を削除）
- Modify: `src-tauri/tests/lock_wiring.rs`（reset テストと import を削除。scan/record_launch のテストは Phase 2 まで温存）
- Modify: `src/lib/ghostDatabase.ts` / `src/lib/ghostDatabase.test.ts`

- [ ] **Step 1: Rust 側撤去** — `commands/db.rs` 削除、`commands/mod.rs` から `pub mod db;` 削除、`lib.rs` の pub use・invoke_handler から `reset_ghost_db` を削除、`lock_wiring.rs` から `reset_ghost_dbは…` テストと `reset_ghost_db` import を削除
- [ ] **Step 2: Rust テスト** — Run: `cargo test` → Expected: all pass
- [ ] **Step 3: JS 回復パスを簡素化**（`initializeDb` から migration リカバリを除去）

```ts
async function initializeDb(): Promise<Database> {
  try {
    const db = await loadDb();
    console.log("[ghostDatabase] Database loaded successfully");
    void reportDbSize(db, "startup").catch(() => {});
    return db;
  } catch (e) {
    // リカバリ不能: Promise をリセットして次回再試行可能にする。
    // 旧「マイグレーション競合 → reset」の回復パスは、使い捨てスキーマ化（Rust 側
    // ensure_cache_schema が起動時に自動リビルド）でエラークラスごと消滅した。
    dbInitPromise = null;
    throw e;
  }
}
```

`ghostDatabase.test.ts` の回復パステスト 2 本（`describe` 内で `reset_ghost_db` を expect しているもの）を削除する。

- [ ] **Step 4: JS テスト** — Run: `npm test` → Expected: all pass（2 本減）
- [ ] **Step 5: コミット** — `refactor: reset_ghost_db と JS 回復パスを撤去（#146 Phase1）`

---

# Phase 2: アクター

### Task 5: `actor/mod.rs` 骨格＋`Job::RecordLaunch`

**Files:**
- Create: `src-tauri/src/actor/mod.rs`
- Modify: `src-tauri/src/lib.rs`（`mod actor;` 追加・`.manage(actor)` は Task 7）
- Modify: `src-tauri/Cargo.toml`（`[dependencies] tokio = { version = "1", features = ["sync"] }` 追加）
- Modify: `src-tauri/src/commands/launch_history.rs`（コマンドをジョブ送信化）

**Interfaces:**
- Produces:
  - `pub(crate) enum Job { RecordLaunch { ghost_identity_key: String, reply: tokio::sync::oneshot::Sender<Result<(), String>> } }`（後続タスクで variant 追加）
  - `pub(crate) struct ActorHandle`（Clone）＋ `pub(crate) fn send(&self, job: Job) -> Result<(), String>`
  - `pub(crate) fn spawn_actor(ghosts_conn: rusqlite::Connection, user_conn: rusqlite::Connection) -> ActorHandle`
- Consumes: `launch_history::record_launch_inner(&user_conn, &ghosts_conn, &key)`（既存・不変）

- [ ] **Step 1: 失敗するテストを書く**（`actor/mod.rs` 内。一時ファイル 2 つの純ユニットテスト）

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDirGuard;

    /// 一時ファイル上に (ghosts, user-data) を初期化してアクターを起動する。
    fn spawn_test_actor(dir: &TempDirGuard) -> ActorHandle {
        let ghosts = rusqlite::Connection::open(dir.path().join("ghosts.db")).unwrap();
        crate::commands::ghost::store::configure_connection(&ghosts).unwrap();
        crate::testutil::apply_cache_schema(&ghosts);
        let user = rusqlite::Connection::open(dir.path().join("user-data.db")).unwrap();
        crate::commands::launch_history::ensure_schema(&user).unwrap();
        spawn_actor(ghosts, user)
    }

    fn send_record(handle: &ActorHandle, key: &str) -> Result<(), String> {
        let (reply, rx) = tokio::sync::oneshot::channel();
        handle
            .send(Job::RecordLaunch { ghost_identity_key: key.to_string(), reply })
            .unwrap();
        rx.blocking_recv().unwrap()
    }

    #[test]
    fn record_launchジョブが両dbへ書き込み応答を返す() {
        let dir = TempDirGuard::new("actor_record_test");
        let handle = spawn_test_actor(&dir);
        send_record(&handle, "sspg").unwrap();
        // アクター所有と別の検証用接続で観測する
        let user = rusqlite::Connection::open(dir.path().join("user-data.db")).unwrap();
        let n: i64 = user
            .query_row("SELECT COUNT(*) FROM ghost_launches WHERE ghost_identity_key='sspg'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn panicジョブでもアクターが生存し次のジョブが成功する() {
        let dir = TempDirGuard::new("actor_panic_test");
        let handle = spawn_test_actor(&dir);
        let (reply, rx) = tokio::sync::oneshot::channel();
        handle.send(Job::PanicForTest { reply }).unwrap();
        let err = rx.blocking_recv().unwrap();
        assert!(err.is_err(), "panic はエラー応答へ変換される");
        // 接続健全性: panic の次のジョブが成功する（設計書 §3.1）
        send_record(&handle, "after-panic").unwrap();
    }

    #[test]
    fn reply受信側をdropしてもジョブは完走しアクターは継続する() {
        let dir = TempDirGuard::new("actor_reply_drop_test");
        let handle = spawn_test_actor(&dir);
        let (reply, rx) = tokio::sync::oneshot::channel();
        handle
            .send(Job::RecordLaunch { ghost_identity_key: "dropped".to_string(), reply })
            .unwrap();
        drop(rx); // 呼び出し側キャンセル
        send_record(&handle, "next").unwrap(); // 継続確認（前ジョブも DB には適用済み）
        let user = rusqlite::Connection::open(dir.path().join("user-data.db")).unwrap();
        let n: i64 = user.query_row("SELECT COUNT(*) FROM ghost_launches", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2, "reply drop されたジョブも完走している");
    }

    #[test]
    fn 全senderのdropで受信ループが終了しスレッドリークしない() {
        let dir = TempDirGuard::new("actor_shutdown_test");
        let handle = spawn_test_actor(&dir);
        let thread = handle.thread_handle_for_test();
        drop(handle);
        // チャネルクローズ → run_loop が return する
        thread.join().expect("アクタースレッドが正常終了する");
    }
}
```

- [ ] **Step 2: 失敗を確認** — Run: `cargo test actor` → Expected: コンパイルエラー
- [ ] **Step 3: 実装**

```rust
// actor/mod.rs
//! ghosts.db への全書き込みを直列化する単一 writer アクター（設計書 §2/§3）。
//! Connection はこのスレッドだけが所有する。排他は「消費者が 1 人のキュー」という構造
//! そのものであり、Mutex もロック配線テストも存在しない。

use rusqlite::Connection;
use std::panic::{catch_unwind, AssertUnwindSafe};
use tokio::sync::{mpsc, oneshot};

/// ghosts.db への書き込みの全種類（設計書 §3）。新しい writer は必ずここに variant を足す。
pub(crate) enum Job {
    RecordLaunch {
        ghost_identity_key: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// テスト専用: run_guarded の panic 隔離・接続健全性を検証するための故意 panic。
    #[cfg(test)]
    PanicForTest { reply: oneshot::Sender<Result<(), String>> },
}

/// アクターへの送信ハンドル。`.manage()` で全コマンドに配られる。
#[derive(Clone)]
pub(crate) struct ActorHandle {
    tx: mpsc::UnboundedSender<Job>,
    #[cfg(test)]
    thread: std::sync::Arc<std::sync::Mutex<Option<std::thread::JoinHandle<()>>>>,
}

impl ActorHandle {
    /// 送信は非ブロッキング（unbounded）。アクター停止後はエラー文字列に写像する（panic しない）。
    pub(crate) fn send(&self, job: Job) -> Result<(), String> {
        self.tx.send(job).map_err(|_| "DB アクターが停止しています".to_string())
    }

    #[cfg(test)]
    pub(crate) fn thread_handle_for_test(&self) -> std::thread::JoinHandle<()> {
        self.thread.lock().unwrap().take().expect("thread handle は 1 回だけ取得できる")
    }
}

/// 所有権を move してアクタースレッドを起動する。呼び出し側（bootstrap／テスト）は
/// スキーマ確定済みの Connection を渡すこと。
pub(crate) fn spawn_actor(ghosts_conn: Connection, user_conn: Connection) -> ActorHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    let thread = std::thread::Builder::new()
        .name("ghost-db-actor".to_string())
        .spawn(move || run_loop(ghosts_conn, user_conn, rx))
        .expect("DB アクタースレッドの起動に失敗");
    ActorHandle {
        tx,
        #[cfg(test)]
        thread: std::sync::Arc::new(std::sync::Mutex::new(Some(thread))),
    }
}

/// 受信ループ。チャネルクローズ（全 Sender drop）で終了する（設計書 §2.2）。
/// ループ本体は panic フリーに保つ（ジョブ内の panic は run_guarded が隔離する）。
fn run_loop(mut ghosts_conn: Connection, user_conn: Connection, mut rx: mpsc::UnboundedReceiver<Job>) {
    while let Some(job) = rx.blocking_recv() {
        handle_job(&mut ghosts_conn, &user_conn, job);
    }
}

fn handle_job(ghosts: &mut Connection, user: &Connection, job: Job) {
    match job {
        Job::RecordLaunch { ghost_identity_key, reply } => {
            let result = run_guarded(ghosts, |g| {
                crate::commands::launch_history::record_launch_inner(user, g, &ghost_identity_key)
            });
            let _ = reply.send(result); // reply drop（呼び出し側キャンセル）は無視。ジョブは完走済み
        }
        #[cfg(test)]
        Job::PanicForTest { reply } => {
            let result = run_guarded(ghosts, |_| -> Result<(), String> { panic!("テスト用 panic") });
            let _ = reply.send(result);
        }
    }
}

/// DB 作業を panic から隔離して実行する（Mutex poison 回復の後継・設計書 §3.1）。
/// panic はエラー応答へ変換し、捕捉後に is_autocommit を検査して開きっぱなしの
/// トランザクションを ROLLBACK する（アクター生存 ≠ 接続健全のギャップを塞ぐ）。
fn run_guarded<T>(
    conn: &mut Connection,
    f: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let result = catch_unwind(AssertUnwindSafe(|| f(&mut *conn)))
        .unwrap_or_else(|_| Err("DB ジョブが panic しました".to_string()));
    if !conn.is_autocommit() {
        let _ = conn.execute_batch("ROLLBACK");
    }
    result
}
```

`record_launch` コマンドをジョブ送信化（`launch_history.rs`。`<R>` 総称化・coordinator は不要になる）:

```rust
/// 起動履歴を記録する Tauri コマンド。実体は DB アクターの RecordLaunch ジョブ（設計書 §3）。
#[tauri::command]
pub async fn record_launch(
    ghost_identity_key: String,
    actor: tauri::State<'_, crate::actor::ActorHandle>,
) -> Result<(), String> {
    let (reply, rx) = tokio::sync::oneshot::channel();
    actor.send(crate::actor::Job::RecordLaunch { ghost_identity_key, reply })?;
    rx.await
        .map_err(|_| "DB アクターから応答がありません".to_string())?
}
```

`open_user_data_db` はこの時点では残す（Task 7 で bootstrap へ吸収）。`lock_wiring.rs` の record_launch テストは削除する（アクター経由になりロック配線が消えるため。scan テストは Task 6 で削除）。`lib.rs` に `mod actor;` を追加。**注意**: Task 7 まで `.manage(ActorHandle)` が無いため、この時点で `record_launch` を実行時に呼ぶと state 不在で失敗する — Task 5〜7 は連続して実施し、間に手動動作確認を挟まない。

- [ ] **Step 4: テスト** — Run: `cargo test actor` → Expected: 4 passed。`cargo test` 全体 → lock_wiring の record_launch テスト削除を反映して all pass
- [ ] **Step 5: コミット** — `feat: GhostDbActor 骨格と RecordLaunch ジョブ（#146 Phase2）`

### Task 6: `Job::Scan` — scan の接続注入化とジョブ移植

**Files:**
- Modify: `src-tauri/src/actor/mod.rs`（Scan variant + ハンドラ）
- Modify: `src-tauri/src/commands/ghost/mod.rs`

**Interfaces:**
- Produces: `Job::Scan { ssp_path: String, additional_folders: Vec<String>, request_key: String, cached_fingerprint: Option<String>, reply: oneshot::Sender<Result<ScanStoreResult, String>> }`
- Produces: `pub(crate) fn scan_and_store_blocking(conn: &rusqlite::Connection, user_conn: &rusqlite::Connection, ssp_path: String, additional_folders: Vec<String>, request_key: String, cached_fingerprint: Option<String>) -> Result<ScanStoreResult, String>`（AppHandle 非依存化）

- [ ] **Step 1: 失敗するテストを書く**（actor tests に追記。並行 delta 直列化テストの後継 = 設計 §9）

```rust
    /// scan_and_store_blocking 相当の実ジョブを 2 本並行送信しても、単一 writer により
    /// 最終状態が「後勝ちの 1 状態」に収束する（旧 scan_lock配下の並行delta テストの後継）。
    #[test]
    fn 並行scanジョブが直列化され整合状態に収束する() {
        use std::fs;
        let dir = TempDirGuard::new("actor_scan_serialize");
        // 2 つの ssp ツリー（ghost_a / ghost_b）
        let (ssp_a, ssp_b) = (dir.path().join("ssp_a"), dir.path().join("ssp_b"));
        for (root, name) in [(&ssp_a, "ghost_a"), (&ssp_b, "ghost_b")] {
            let base = root.join("ghost").join(name).join("ghost").join("master");
            fs::create_dir_all(&base).unwrap();
            fs::write(base.join("descript.txt"), "name,Test\ncharset,UTF-8\n").unwrap();
        }
        let handle = spawn_test_actor(&dir);
        let mut rxs = Vec::new();
        for ssp in [&ssp_a, &ssp_b] {
            let (reply, rx) = tokio::sync::oneshot::channel();
            handle
                .send(Job::Scan {
                    ssp_path: ssp.to_string_lossy().to_string(),
                    additional_folders: Vec::new(),
                    request_key: "rk".to_string(),
                    cached_fingerprint: None,
                    reply,
                })
                .unwrap();
            rxs.push(rx);
        }
        for rx in rxs {
            rx.blocking_recv().unwrap().unwrap();
        }
        let conn = rusqlite::Connection::open(dir.path().join("ghosts.db")).unwrap();
        let ghosts: i64 = conn.query_row("SELECT COUNT(*) FROM ghosts WHERE request_key='rk'", [], |r| r.get(0)).unwrap();
        let entries: i64 = conn
            .query_row("SELECT COUNT(*) FROM ghost_scan_entries WHERE request_key='rk'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ghosts, 1, "直列化後は 1 体（後勝ちの entries）のはず");
        assert_eq!(ghosts, entries, "ghosts と scan_entries が整合しているはず");
    }
```

- [ ] **Step 2: 失敗を確認** — Run: `cargo test 並行scanジョブ` → Expected: コンパイルエラー（`Job::Scan` 未定義）
- [ ] **Step 3: 実装**

`commands/ghost/mod.rs` の変更:
1. `scan_and_store_blocking` のシグネチャを Interfaces のとおり変更。内部の「DB パス解決＋`Connection::open`＋`configure_connection`」3 箇所（Layer 1・Layer 2 hit・miss）を**すべて削除**し、引数 `conn` を直接使う（Layer 1 の `db_path.exists()` 条件も削除 — アクター所有接続は常にスキーマ確定済み）。`backfill_launch_aggregates(app, &conn)` 3 箇所を `let _ = crate::commands::launch_history::backfill_aggregates(conn, user_conn);` に置換し、`backfill_launch_aggregates` ヘルパーと `ensure_request_key` 以外の AppHandle 依存を除去
2. コマンドはジョブ送信化:

```rust
/// ゴーストをスキャンし SQLite へ直接書き込むコマンド。実体は DB アクターの Scan ジョブ。
/// walk＋parse＋DB 適用の全体がアクター上で直列化される（設計書 §3。2 scan が同じ prev から
/// 差分計算する lost update を構造的に防ぐ）。IPC 契約（引数名・戻り値）は不変。
#[tauri::command]
pub async fn scan_and_store(
    ssp_path: String,
    additional_folders: Vec<String>,
    request_key: String,
    cached_fingerprint: Option<String>,
    actor: tauri::State<'_, crate::actor::ActorHandle>,
) -> Result<ScanStoreResult, String> {
    let (reply, rx) = tokio::sync::oneshot::channel();
    actor.send(crate::actor::Job::Scan {
        ssp_path,
        additional_folders,
        request_key,
        cached_fingerprint,
        reply,
    })?;
    rx.await
        .map_err(|_| "DB アクターから応答がありません".to_string())?
}
```

`actor/mod.rs` のハンドラ追加（match 内）:

```rust
        Job::Scan { ssp_path, additional_folders, request_key, cached_fingerprint, reply } => {
            let result = run_guarded(ghosts, |g| {
                crate::commands::ghost::scan_and_store_blocking(
                    g, user, ssp_path, additional_folders, request_key, cached_fingerprint,
                )
            });
            let _ = reply.send(result);
        }
```

（`run_guarded` のクロージャは `&mut Connection` を受けるが `scan_and_store_blocking` は `&Connection` で足りるため、そのまま `g` を渡す＝自動 reborrow）

3. `lock_wiring.rs` の scan テストを削除（ファイルには何も残らないが、削除自体は Task 8）。`ghost/mod.rs` 既存テストのうち `scan_lock配下の並行deltaが整合状態を壊さない` を削除（Step 1 の後継テストが置換）

- [ ] **Step 4: テスト** — Run: `cargo test` → Expected: all pass（actor 5 本目が緑）
- [ ] **Step 5: コミット** — `feat: scan を Scan ジョブへ移植し接続注入化（#146 Phase2）`

### Task 7: `bootstrap` — 起動配線のアクター統合と可視性封鎖

**Files:**
- Move: `src-tauri/src/db_path.rs` → `src-tauri/src/actor/db_path.rs`（`pub(crate)` → `pub(super)`）
- Modify: `src-tauri/src/actor/mod.rs`（`mod db_path;` + `bootstrap`）
- Modify: `src-tauri/src/lib.rs`（setup を bootstrap 1 本に・`mod db_path;` 削除・`sanitize_ghost_db`/`init_user_data`/`init_cache_schema` を actor へ移設）
- Modify: `src-tauri/src/commands/launch_history.rs`（`open_user_data_db` を bootstrap へ吸収・削除）

**Interfaces:**
- Produces: `pub(crate) fn bootstrap(app: &tauri::App) -> Result<ActorHandle, String>`
- Consumes: `cache_schema::ensure_cache_schema`・`launch_history::{ensure_schema, migrate_legacy_launch_history}`・`ghost::store::configure_connection`

- [ ] **Step 1: 実装**（bootstrap は AppHandle 依存のため純ユニットテスト対象外。順序は Task 3 のアップグレードテストが縛る）

`actor/mod.rs` に追加:

```rust
mod db_path;

/// 起動配線（設計書 §2.1 の 5 ステップ・すべて setup スレッドで同期実行）。
/// 順序は不変条件: sanitize → user-data 初期化＋legacy 移送 → スキーマ確定 → スレッド起動。
/// 特に「移送 → ensure_cache_schema」の順序を破ると、旧世代 DB の永続履歴が
/// リビルドの全 DROP に巻き込まれて失われる（issue #93/#146）。
pub(crate) fn bootstrap(app: &tauri::App) -> Result<ActorHandle, String> {
    // (1) パス解決（単一権威・ここ以外に ghosts.db のパスを知るコードは存在しない）と最小 sanitize
    let db_dir = db_path::ghost_db_dir(app)?;
    let ghosts_path = db_dir.join(db_path::GHOST_DB_FILES[0]);
    sanitize(&db_dir, &ghosts_path);

    // (2) user-data 初期化 + legacy 移送
    let user_path = db_path::user_data_db_path(app)?;
    let user_conn = rusqlite::Connection::open(&user_path)
        .map_err(|e| format!("user-data.db オープンエラー: {e}"))?;
    crate::commands::ghost::store::configure_connection(&user_conn)?;
    crate::commands::launch_history::ensure_schema(&user_conn)?;
    if ghosts_path.exists() {
        if let Ok(g) = rusqlite::Connection::open(&ghosts_path) {
            let _ = crate::commands::launch_history::migrate_legacy_launch_history(&g, &user_conn);
        }
    }

    // (3) ghosts を開きスキーマ確定（webview ロード前なので初回 SELECT は必ず確定後）。
    //     失敗時は fs 削除リトライ 1 回（Task 3 の init_cache_schema_at と同一の回復。
    //     設計書 §4 の裁定 — Phase 1 で導入済みのヘルパーを流用する）
    let ghosts_conn = crate::cache_schema::open_with_recovery(&ghosts_path)?;

    // (4) 所有権 move でスレッド起動
    Ok(spawn_actor(ghosts_conn, user_conn))
}

/// ghosts.db が破損して open 不能なら関連ファイルごと削除する（webview ロード前なので競合なし）。
fn sanitize(db_dir: &std::path::Path, ghosts_path: &std::path::Path) {
    if !ghosts_path.exists() {
        return;
    }
    let ok = rusqlite::Connection::open(ghosts_path)
        .and_then(|c| c.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0)))
        .is_ok();
    if !ok {
        for filename in db_path::GHOST_DB_FILES {
            let _ = std::fs::remove_file(db_dir.join(filename));
        }
    }
}
```

`lib.rs`: `mod db_path;` を削除、setup を置換:

```rust
        .setup(|app| {
            match actor::bootstrap(app) {
                Ok(handle) => {
                    app.manage(handle);
                }
                Err(e) => return Err(format!("DB アクターの起動に失敗しました: {e}").into()),
            }
            Ok(())
        })
```

`lib.rs` の `sanitize_ghost_db`・`init_user_data`・`init_cache_schema` を削除（bootstrap へ吸収済み）。`.manage(scan_coordinator::ScanCoordinator::default())` は Task 8 で削除。`launch_history::open_user_data_db` を削除し、参照していた箇所（既に record_launch はジョブ化済みでゼロのはず）を確認する。`db_path.rs` の各 fn を `pub(super)` にし、doc コメントへ「actor モジュール専有（可視性封鎖・設計書 §2.3）。コマンド層から ghosts.db のパス解決はできない」と追記。

- [ ] **Step 2: コンパイル確認** — Run: `cargo check`（`db_path` 参照が actor 外に残っていればここで可視性エラーとして洗い出される。残存参照は本タスクの漏れなので bootstrap 経由に修正する） → Expected: pass
- [ ] **Step 3: テスト** — Run: `cargo test` → Expected: all pass
- [ ] **Step 4: 動作確認** — Run: `npm run tauri dev` を起動し、(a) 一覧表示（初回リビルド＋フルスキャン）、(b) ゴースト起動（record_launch）、(c) 再起動して cache hit、を目視確認して終了
- [ ] **Step 5: コミット** — `feat: 起動配線を actor::bootstrap へ統合し db_path を可視性封鎖（#146 Phase2）`

### Task 8: ロック方式の撤去

**Files:**
- Delete: `src-tauri/src/scan_coordinator.rs`・`src-tauri/tests/lock_wiring.rs`・`src-tauri/tests-common-controls-v6.manifest`
- Modify: `src-tauri/src/lib.rs`（`mod scan_coordinator;`・`pub use`（ScanCoordinator/scan_and_store/record_launch）・`.manage(ScanCoordinator...)` を削除）
- Modify: `src-tauri/build.rs`（`rustc-link-arg-tests` の節を削除し `tauri_build::build()` のみに）
- Modify: `src-tauri/Cargo.toml`（dev-dependencies の `tauri = { features = ["test"] }` を削除）
- Modify: `src-tauri/src/commands/ghost/mod.rs`・`launch_history.rs`（残存する `<R: tauri::Runtime>` 総称化と doc の削除 — 対象 fn はすべて AppHandle 非依存化済みのため型パラメータごと消える）

- [ ] **Step 1: 撤去実行**（上記ファイル操作。`git rm` を使用）
- [ ] **Step 2: 全テスト** — Run: `cargo test` → Expected: all pass（lock_wiring 3 本が消え actor 5 本が残る）
- [ ] **Step 3: コミット** — `refactor: ScanCoordinator と lock_wiring 検証装置一式を撤去（#146 Phase2）`

### Task 9: 構造ガードの lint 保険

**Files:**
- Create: `clippy.toml`（リポジトリルート）
- Modify: `.github/workflows/ci-build.yml`（clippy ステップ追加）

- [ ] **Step 1: clippy.toml を作成**

```toml
# ghosts.db への writer 混入ガード（設計書 §2.3）: 接続は actor モジュールだけが開く。
[[disallowed-methods]]
path = "rusqlite::Connection::open"
reason = "ghosts.db/user-data.db の接続は actor::bootstrap と spawn_actor 経由のみ。テストは #[allow(clippy::disallowed_methods)] を付ける"
```

- [ ] **Step 2: 違反箇所の整理** — Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -A clippy::all -D clippy::disallowed-methods`
  actor モジュール内と `#[cfg(test)]` の正当な `Connection::open` に `#[allow(clippy::disallowed_methods)]`（テストは mod 単位で可）を付け、**本番コードの actor 外に violation がゼロ**であることを確認する
- [ ] **Step 3: CI にステップ追加**（`ci-build.yml` の Rust テストの後）

```yaml
      - name: Clippy (writer 混入ガード)
        run: cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -A clippy::all -D clippy::disallowed-methods
```

- [ ] **Step 4: コミット** — `chore: Connection::open を actor 外で禁止する clippy ガード（#146 Phase2）`

---

# Phase 3: JS 読み取り専用化

### Task 10: `Job::CleanupCaches` と `cleanup_ghost_caches` コマンド

**Files:**
- Modify: `src-tauri/src/actor/mod.rs`（variant + ハンドラ）
- Modify: `src-tauri/src/commands/ghost/store.rs`（`cleanup_old_ghost_caches` 実装＋テスト）
- Modify: `src-tauri/src/commands/ghost/mod.rs`（コマンド追加）
- Modify: `src-tauri/src/lib.rs`（invoke_handler へ追加）

**Interfaces:**
- Produces: `Job::CleanupCaches { current_request_key: String, reply: oneshot::Sender<Result<u32, String>> }`
- Produces: `store::cleanup_old_ghost_caches(conn: &rusqlite::Connection, current_request_key: &str, max_generations: usize, ttl_days: i64) -> Result<u32, String>`（戻り値 = 削除した request_key 数）
- Produces: コマンド `cleanup_ghost_caches(currentRequestKey) -> number`（設計 §5.1 の契約）

- [ ] **Step 1: 失敗するテストを書く**（`store.rs` tests。JS `ghostDatabase.test.ts` の 4 本の移植）

```rust
    fn seed_generation(conn: &Connection, request_key: &str, updated_at: &str) {
        conn.execute(
            "INSERT INTO ghosts (request_key, ghost_identity_key, row_fingerprint, name, sakura_name, kero_name, craftman, craftmanw, directory_name, path, source, name_lower, sakura_name_lower, kero_name_lower, craftman_lower, craftmanw_lower, directory_name_lower, thumbnail_path, thumbnail_use_self_alpha, thumbnail_kind, updated_at) VALUES (?1, ?1 || 'g', '', 'G', '', '', '', '', 'g', '/g', 'ssp', 'g', '', '', '', '', 'g', '', 0, '', ?2)",
            rusqlite::params![request_key, updated_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ghost_fingerprints (request_key, fingerprint, updated_at) VALUES (?1, 'fp', ?2)",
            rusqlite::params![request_key, updated_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ghost_scan_entries (request_key, scan_key, token, ghost_identity_key) VALUES (?1, 'sk', 't', ?1 || 'g')",
            rusqlite::params![request_key],
        )
        .unwrap();
    }

    fn remaining_keys(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT DISTINCT request_key FROM ghosts ORDER BY request_key")
            .unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().filter_map(Result::ok).collect()
    }

    #[test]
    fn cleanupは世代上限を超えた古いキャッシュを3テーブルとも削除する() {
        let conn = setup_db();
        seed_generation(&conn, "rk-old", "2026-01-01 00:00:00");
        seed_generation(&conn, "rk-mid", "2026-06-01 00:00:00");
        seed_generation(&conn, "rk-new", "2026-07-01 00:00:00");
        let deleted = cleanup_old_ghost_caches(&conn, "rk-new", 2, 30).unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(remaining_keys(&conn), vec!["rk-mid".to_string(), "rk-new".to_string()]);
        let fp: i64 = conn
            .query_row("SELECT COUNT(*) FROM ghost_fingerprints WHERE request_key='rk-old'", [], |r| r.get(0))
            .unwrap();
        let se: i64 = conn
            .query_row("SELECT COUNT(*) FROM ghost_scan_entries WHERE request_key='rk-old'", [], |r| r.get(0))
            .unwrap();
        assert_eq!((fp, se), (0, 0), "fingerprints/scan_entries も同時削除される");
    }

    #[test]
    fn cleanupはttl超過の世代を上限内でも削除するがcurrentは保護する() {
        let conn = setup_db();
        seed_generation(&conn, "rk-expired", "2020-01-01 00:00:00"); // TTL 超過
        seed_generation(&conn, "rk-current", "2020-01-02 00:00:00"); // TTL 超過だが current
        let deleted = cleanup_old_ghost_caches(&conn, "rk-current", 5, 30).unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(remaining_keys(&conn), vec!["rk-current".to_string()]);
    }

    #[test]
    fn cleanupは対象なしなら0を返し何も消さない() {
        let conn = setup_db();
        seed_generation(&conn, "rk-current", "2099-01-01 00:00:00");
        let deleted = cleanup_old_ghost_caches(&conn, "rk-current", 5, 30).unwrap();
        assert_eq!(deleted, 0);
        assert_eq!(remaining_keys(&conn), vec!["rk-current".to_string()]);
    }

    #[test]
    fn cleanupは世代0でもcurrentだけは残す() {
        let conn = setup_db();
        seed_generation(&conn, "rk-a", "2099-01-01 00:00:00");
        seed_generation(&conn, "rk-current", "2099-01-02 00:00:00");
        let deleted = cleanup_old_ghost_caches(&conn, "rk-current", 0, 30).unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(remaining_keys(&conn), vec!["rk-current".to_string()]);
    }
```

- [ ] **Step 2: 失敗を確認** — Run: `cargo test cleanup` → Expected: コンパイルエラー
- [ ] **Step 3: 実装**（`store.rs`。JS `cleanupOldGhostCaches` の移植。TTL 判定は SQL の `datetime('now', '-N days')` 比較へ寄せる — JS の `Date.parse` 不能値→非期限切れの挙動は、SQL では文字列比較になるが実データは常に `datetime('now')` 形式のため実害なし）

```rust
/// 古い request_key 世代のキャッシュを削除する（JS cleanupOldGhostCaches の移植・設計書 §5.1）。
/// 保持規則: 更新降順の上位 max_generations（TTL 未超過のもの）+ current は無条件。
/// ghosts / ghost_fingerprints / ghost_scan_entries は運命共有のため同一トランザクションで消す。
pub(crate) fn cleanup_old_ghost_caches(
    conn: &Connection,
    current_request_key: &str,
    max_generations: usize,
    ttl_days: i64,
) -> Result<u32, String> {
    let rows: Vec<(String, bool)> = {
        let mut stmt = conn
            .prepare(
                "SELECT request_key, MAX(updated_at) < datetime('now', ?1) FROM ghosts GROUP BY request_key ORDER BY MAX(updated_at) DESC",
            )
            .map_err(|e| format!("世代 SELECT 準備エラー: {e}"))?;
        stmt.query_map([format!("-{ttl_days} days")], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| format!("世代 SELECT エラー: {e}"))?
            .filter_map(Result::ok)
            .collect()
    };
    let keep_by_generation: std::collections::HashSet<&str> =
        rows.iter().take(max_generations).map(|(k, _)| k.as_str()).collect();
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("cleanup 開始エラー: {e}"))?;
    let mut deleted: u32 = 0;
    for (key, ttl_expired) in &rows {
        let keep = (keep_by_generation.contains(key.as_str()) && !ttl_expired)
            || key == current_request_key;
        if keep {
            continue;
        }
        for sql in [
            "DELETE FROM ghosts WHERE request_key = ?1",
            "DELETE FROM ghost_fingerprints WHERE request_key = ?1",
            "DELETE FROM ghost_scan_entries WHERE request_key = ?1",
        ] {
            tx.execute(sql, [key]).map_err(|e| format!("cleanup DELETE エラー: {e}"))?;
        }
        deleted += 1;
    }
    tx.commit().map_err(|e| format!("cleanup commit エラー: {e}"))?;
    Ok(deleted)
}
```

actor に variant／ハンドラ追加（ポリシー定数は actor 側）:

```rust
/// cleanup ポリシー（設計書 §5.1。JS 時代の既定値を Rust 定数化）
const CLEANUP_MAX_GENERATIONS: usize = 5;
const CLEANUP_TTL_DAYS: i64 = 30;
```

```rust
        Job::CleanupCaches { current_request_key, reply } => {
            let result = run_guarded(ghosts, |g| {
                crate::commands::ghost::store::cleanup_old_ghost_caches(
                    g, &current_request_key, CLEANUP_MAX_GENERATIONS, CLEANUP_TTL_DAYS,
                )
            });
            let _ = reply.send(result);
        }
```

コマンド（`commands/ghost/mod.rs`）＋ `lib.rs` invoke_handler へ `commands::ghost::cleanup_ghost_caches` 追加:

```rust
/// 古い request_key 世代のキャッシュを削除するコマンド（設計書 §5.1 の契約）。
/// 戻り値は削除した request_key 数（JS はログにのみ使用）。
#[tauri::command]
pub async fn cleanup_ghost_caches(
    current_request_key: String,
    actor: tauri::State<'_, crate::actor::ActorHandle>,
) -> Result<u32, String> {
    let (reply, rx) = tokio::sync::oneshot::channel();
    actor.send(crate::actor::Job::CleanupCaches { current_request_key, reply })?;
    rx.await
        .map_err(|_| "DB アクターから応答がありません".to_string())?
}
```

- [ ] **Step 4: テスト** — Run: `cargo test` → Expected: all pass（cleanup 4 本追加）
- [ ] **Step 5: コミット** — `feat: cleanup_ghost_caches コマンドと CleanupCaches ジョブ（#146 Phase3）`

### Task 11: JS 側 cleanup の invoke 化

**Files:**
- Modify: `src/lib/ghostDatabase.ts`
- Modify: `src/lib/ghostDatabase.test.ts`（旧ポリシーテスト 4 本を削除し invoke 契約テストに置換）
- Verify: `src/lib/ghostCatalogService.ts:53`（関数名不変のため無変更で通ることを確認）

- [ ] **Step 1: 失敗するテストを書く**（`ghostDatabase.test.ts`。旧 `describe("ghostDatabase - cleanupOldGhostCaches")` の 4 本を削除して置換）

```ts
describe("cleanupOldGhostCaches", () => {
  it("cleanup_ghost_caches IPC を camelCase 引数で呼ぶ", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue(1);
    const { cleanupOldGhostCaches } = await import("./ghostDatabase");
    await cleanupOldGhostCaches("c:/ssp::");
    expect(invoke).toHaveBeenCalledWith("cleanup_ghost_caches", { currentRequestKey: "c:/ssp::" });
  });
});
```

- [ ] **Step 2: 失敗を確認** — Run: `npx vitest run src/lib/ghostDatabase.test.ts` → Expected: FAIL（現行実装は db.select/execute を呼ぶ）
- [ ] **Step 3: 実装**（`ghostDatabase.ts` の `cleanupOldGhostCaches` を置換。`RequestKeyRow`・`buildInClausePlaceholders` は他に使用がなければ削除）

```ts
/// 古い request_key 世代のキャッシュ削除。実体は Rust の CleanupCaches ジョブ
/// （ポリシー: 世代 5・TTL 30 日は Rust 側 const）。戻り値は削除世代数。
export async function cleanupOldGhostCaches(currentRequestKey: string): Promise<void> {
  const deleted = await invoke<number>("cleanup_ghost_caches", { currentRequestKey });
  if (deleted > 0) {
    console.log(`[ghostDatabase] Cleaned ${deleted} stale request_key caches`);
  }
}
```

- [ ] **Step 4: テスト** — Run: `npm test` → Expected: all pass（`ghostCatalogService.test.ts` は `cleanupOldGhostCaches` をモジュールモックしているため無修正で通る。通らなければモック契約を確認）
- [ ] **Step 5: コミット** — `refactor: cleanupOldGhostCaches を invoke ベースへ移行（#146 Phase3）`

### Task 12: `Job::Maintenance` と JS PRAGMA 削減

**Files:**
- Modify: `src-tauri/src/actor/mod.rs`（Maintenance variant・spawn 直後の self-enqueue・`maintenance` fn）
- Modify: `src-tauri/src/commands/ghost/store.rs`（`configure_connection` に `journal_size_limit` 追加）
- Modify: `src/lib/ghostDatabase.ts`（`loadDb` の PRAGMA 削減・`vacuumIfNeeded` 削除）

- [ ] **Step 1: 失敗するテストを書く**（actor tests）

```rust
    #[test]
    fn maintenanceジョブはエラーでもアクターを止めない() {
        let dir = TempDirGuard::new("actor_maintenance_test");
        let handle = spawn_test_actor(&dir);
        handle.send(Job::Maintenance).unwrap();
        // Maintenance は reply を持たない。後続ジョブの成功が「止まっていない」ことの観測
        send_record(&handle, "after-maintenance").unwrap();
    }
```

- [ ] **Step 2: 失敗を確認** — Run: `cargo test maintenanceジョブ` → Expected: コンパイルエラー
- [ ] **Step 3: 実装**

actor（variant は reply なし・spawn_actor 内の thread 起動直後に `let _ = tx.send(Job::Maintenance);` を追加）:

```rust
/// VACUUM の実行条件（JS vacuumIfNeeded の移植・設計書 §5.2）
const VACUUM_FREE_RATIO: f64 = 0.25;
const VACUUM_FREE_BYTES: i64 = 1_048_576;
```

```rust
        Job::Maintenance => {
            // 失敗してもログのみで続行（現行 JS の try-catch 方針を踏襲）。reply なし。
            if let Err(e) = maintenance(ghosts) {
                eprintln!("[ghost-db-actor] メンテナンスをスキップしました: {e}");
            }
        }
```

```rust
/// 起動直後の自己投入ジョブ: ANALYZE（optimize）と条件付き VACUUM。
/// アクタースレッド上で走るため webview ロードも setup もブロックしない（設計書 §5.2）。
fn maintenance(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA optimize=0x10002;")
        .map_err(|e| format!("optimize エラー: {e}"))?;
    let q = |sql: &str| -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap_or(0)
    };
    let page_count = q("PRAGMA page_count");
    if page_count == 0 {
        return Ok(());
    }
    let freelist = q("PRAGMA freelist_count");
    let page_size = {
        let v = q("PRAGMA page_size");
        if v == 0 { 4096 } else { v }
    };
    let free_bytes = freelist * page_size;
    let free_ratio = freelist as f64 / page_count as f64;
    if free_ratio >= VACUUM_FREE_RATIO && free_bytes >= VACUUM_FREE_BYTES {
        conn.execute_batch("VACUUM").map_err(|e| format!("VACUUM エラー: {e}"))?;
    }
    Ok(())
}
```

`configure_connection` の PRAGMA 文字列に `PRAGMA journal_size_limit=4194304;` を追加（JS から移設）。

JS `loadDb`（`vacuumIfNeeded`・定数 `VACUUM_FREE_RATIO`/`VACUUM_FREE_BYTES` を削除）:

```ts
async function loadDb(): Promise<Database> {
  const db = await Database.load("sqlite:ghosts.db");
  // 読者に必要な PRAGMA のみ。journal_mode=WAL はファイル永続属性で Rust 側が設定済み。
  // sqlx-sqlite は接続確立毎にデフォルト 5 秒の busy_timeout を全プール接続へ適用するため
  // この明示は保険（sqlx 更新でデフォルトが変わった場合の防波堤）。
  await db.execute("PRAGMA busy_timeout=5000");
  return db;
}
```

- [ ] **Step 4: テスト** — Run: `cargo test && npm test` → Expected: all pass
- [ ] **Step 5: コミット** — `feat: VACUUM/optimize を Maintenance ジョブへ移動し JS を読み取り専用化（#146 Phase3）`

### Task 13: ドキュメント同期と最終検証

**Files:**
- Modify: `SPEC.md`・`CLAUDE.md`（ルート）・`src-tauri/CLAUDE.md`
- Verify: 設計書 `docs/superpowers/specs/2026-07-16-ghost-db-actor-design.md` との整合

- [ ] **Step 1: SPEC.md 同期**（設計 §7 の対象一覧）
  - §4.3/§4.4: 「migration に DELETE FROM を含める」等の migration 前提記述を「CACHE_SCHEMA の変更（＝自動リビルド）」へ書き換え
  - §6.4 `reset_ghost_db`: 節ごと削除
  - §6.6 `record_launch`: 直列化の記述を「DB アクターの RecordLaunch ジョブ」へ
  - §6.x: `cleanup_ghost_caches` の節を追加（Task 10 の契約表）
  - §8.1 手順 6・§8.1.1: cleanup の invoke 化・PRAGMA 責務分担（JS は busy_timeout のみ・他はアクター）
  - §13: 「マイグレーション競合 → reset_ghost_db」行を「スキーマ世代不一致 → 起動時 ensure_cache_schema が自動リビルド／破損 → 起動時 sanitize が fs 削除」へ置換
- [ ] **Step 2: CLAUDE.md 同期**
  - ルート: ディレクトリ構成ツリー（`commands/db.rs` 削除・`actor/`・`cache_schema.rs` 追加・`db_path.rs` の説明を actor 配下へ）
  - `src-tauri/CLAUDE.md`: 「マイグレーション制約」「マイグレーション SQL の不変性」「マイグレーションエラー自動回復」の 3 節を「使い捨てスキーマ（cache_schema.rs）: CACHE_SCHEMA が単一権威・ハッシュ user_version・変更すれば全ユーザー再スキャン。parity テストはスキーマ初変更時に旧 migrations() ごと削除」へ置換。「rusqlite 直接書き込み」節に単一 writer アクターの記述を追加
- [ ] **Step 3: 最終ゲート** — `/commit` チェックリスト全実行（npm build/test・UI ガイドライン・cargo workspace・ghost-meta features・生成型照合）＋ `cargo clippy`（Task 9 のコマンド） → Expected: all pass
- [ ] **Step 4: コミット** — `docs: 使い捨てスキーマとアクター化を SPEC/CLAUDE に同期（#146 Phase3）`
- [ ] **Step 5: PR 作成は全フェーズ完了後に `/pr` で一括**（プロジェクト規約）

---

## Self-Review 済み事項

- **Spec coverage**: 設計 §2.1（Task 7 bootstrap＋Task 3 テスト）・§2.2（Task 5 shutdown テスト）・§2.3（Task 7 可視性＋Task 9 lint）・§3（Task 5/6/10/12 の Job 4 種＋§3.1 は run_guarded とテスト）・§4（Task 1/2/3）・§5.1（Task 10/11）・§5.2（Task 12）・§6（Task 4/8）・§8（Task 2/9）・§9（各タスクのテスト）— 全節にタスクあり
- **既知の逸脱**: cleanup の TTL 判定を JS の `Date.parse` から SQL `datetime` 比較へ変更（実データは常に datetime 形式のため挙動同一。Task 10 Step 3 に注記）
- **型整合**: `ActorHandle.send(Job)`／`oneshot::Sender<Result<T, String>>` の T は scan=`ScanStoreResult`・record=`()`・cleanup=`u32` で全タスク一貫
