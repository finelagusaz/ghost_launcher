# 永続テーブル分離（user-data.db）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 起動履歴 `ghost_launches` を揮発キャッシュ `ghosts.db` から Rust 専有の `user-data.db` へ分離し、マイグレーション競合時のリセットが永続データを巻き添え削除する不変条件違反（issue #93）を解消する。

**Architecture:** `ghost_launches` を新設 `user-data.db`（rusqlite 単一接続のみが触る）へ移す。cross-DB JOIN は `tauri-plugin-sql` のプール揮発で ATTACH が使えないため廃止し、`ghosts` へ非正規化した集計列 `last_launched` / `launch_count` を持たせて recent/frequency を単一 DB のプレーン ORDER BY に置換する。集計列は `record_launch`（起動時）で即時更新し、`scan_and_store`（スキャン時）で user-data.db から再導出（バックフィル）する。旧履歴は初回起動時に一度だけ複写する。

**Tech Stack:** Rust（rusqlite / tauri 2）, TypeScript（React 19 / vitest）, SQLite。

## Global Constraints

- マイグレーション SQL の不変性: 一度コミットした migration の SQL 文字列は**絶対に編集しない**（SHA-384 チェックサム再検証でクラッシュ）。複数行 SQL は `\n` を明示（raw 改行 + インデント禁止）。
- `ALTER TABLE ... ADD COLUMN ... DEFAULT` の値は**リテラルのみ**（`datetime('now')` 等の関数は不可）。実時刻は INSERT/UPDATE の文で `datetime('now')` を使う。
- Tauri IPC: `invoke()` は引数名を camelCase → snake_case へ自動変換（戻り値は変換しない）。
- 機械キーの整列に `localeCompare` を使わない（コードポイント順）。本計画は整列を変更しないが遵守。
- ライフサイクル順序保証: 当アプリは `plugins.sql.preload` を**使わない**（確認済み）。従って sqlx マイグレーションは JS の `Database.load("sqlite:ghosts.db")` 呼び出し時に実行され、Rust の `.setup()` クロージャは常にそれより先に走る。本計画の「移送（setup）→ 旧テーブル DROP（migration 13）」順序はこの保証に依存する。
- 検証コマンド: `cargo test --manifest-path src-tauri/Cargo.toml` / `npm test` / `npm run build` / `npm run check:ui-guidelines`。

---

## ファイル構成

- Create: `src-tauri/src/commands/launch_history.rs` — user-data.db のスキーマ・起動履歴操作（open / ensure_schema / record_launch / backfill / legacy 移送）と `record_launch` コマンド。
- Modify: `src-tauri/src/db_path.rs` — `user_data_db_path()` 追加（パス解決の単一権威）。
- Modify: `src-tauri/src/commands/mod.rs` — `pub mod launch_history;` 追加。
- Modify: `src-tauri/src/lib.rs` — migration 12/13 追加、`.setup()` で user-data 初期化＋legacy 移送、`record_launch` コマンド登録、スキーマ検証テスト追加。
- Modify: `src-tauri/src/commands/ghost/mod.rs` — `scan_and_store` の cache miss 経路末尾でバックフィルを呼ぶ。
- Modify: `src/lib/ghostDatabase.ts` — `recordLaunch` を `invoke("record_launch")` へ、`buildOrderBy` の JOIN 廃止＋集計列 ORDER BY、`from` 条件分岐の除去、コメント訂正。
- Modify: `src-tauri/CLAUDE.md` / `SPEC.md` — 「キャッシュなので安全」記述を分離後の正しい記述へ同期。

**タスク依存順の注意:** migration 12（集計列追加）は record_launch/backfill のテストが読む列を用意するため、それらより**先**に置く（Task 2）。

---

## Task 1: user-data.db スキーマと接続（Rust）

**Files:**
- Modify: `src-tauri/src/db_path.rs`
- Create: `src-tauri/src/commands/launch_history.rs`
- Modify: `src-tauri/src/commands/mod.rs`

**Interfaces:**
- Produces:
  - `db_path::user_data_db_path<R: tauri::Runtime>(&impl Manager<R>) -> Result<PathBuf, String>`
  - `commands::launch_history::ensure_schema(conn: &rusqlite::Connection) -> Result<(), String>`
  - `commands::launch_history::open_user_data_db<R: tauri::Runtime>(&impl Manager<R>) -> Result<rusqlite::Connection, String>`

- [ ] **Step 1: db_path.rs に user-data.db パス解決を追加**

`src-tauri/src/db_path.rs` の末尾（`ghost_db_path` の後）に追加:

```rust
/// user-data.db（永続ユーザーデータ）本体のフルパス。ghosts.db と同じ app_config_dir 基準。
/// user-data.db は永続ストアであり、reset_ghost_db / sanitize_ghost_db の削除対象に含めない。
pub(crate) fn user_data_db_path<R: tauri::Runtime>(
    manager: &impl Manager<R>,
) -> Result<std::path::PathBuf, String> {
    Ok(ghost_db_dir(manager)?.join("user-data.db"))
}
```

- [ ] **Step 2: commands/mod.rs にモジュール登録**

`src-tauri/src/commands/mod.rs` を次へ（アルファベット順の位置に追加）:

```rust
pub mod db;
pub mod ghost;
pub mod launch_history;
pub mod locale;
pub mod ssp;
```

- [ ] **Step 3: launch_history.rs を作成し失敗するテストを書く**

`src-tauri/src/commands/launch_history.rs` を新規作成:

```rust
use rusqlite::Connection;
use tauri::Manager;

/// user-data.db に起動履歴テーブルを冪等に用意する。
/// ここは sqlx マイグレーション系に載せない（永続ストアなので自動削除の事故クラスが構造上発生しない）。
pub(crate) fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ghost_launches (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  ghost_identity_key TEXT NOT NULL,\n  launched_at TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_ghost_launches_identity ON ghost_launches(ghost_identity_key);\nCREATE INDEX IF NOT EXISTS idx_ghost_launches_at ON ghost_launches(launched_at DESC);",
    )
    .map_err(|e| format!("user-data スキーマ作成エラー: {e}"))
}

/// user-data.db を開き、書込用 PRAGMA を適用し、スキーマを用意して返す。
pub(crate) fn open_user_data_db<R: tauri::Runtime>(
    manager: &impl Manager<R>,
) -> Result<Connection, String> {
    let path = crate::db_path::user_data_db_path(manager)?;
    let conn = Connection::open(&path).map_err(|e| format!("user-data.db オープンエラー: {e}"))?;
    crate::commands::ghost::store::configure_connection(&conn)?;
    ensure_schema(&conn)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_schemaはghost_launchesテーブルを冪等に作る() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        // 二重呼び出しでも失敗しない（IF NOT EXISTS）
        ensure_schema(&conn).unwrap();

        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(ghost_launches)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(cols.contains(&"ghost_identity_key".to_string()));
        assert!(cols.contains(&"launched_at".to_string()));
    }
}
```

- [ ] **Step 4: テストが失敗することを確認**

まず `commands/mod.rs` の `pub mod launch_history;` を入れずにビルドし「モジュール未解決」を確認してから Step 2 を適用する。
Run: `cargo test --manifest-path src-tauri/Cargo.toml ensure_schema`
Expected: 未適用時はコンパイルエラー、Step 1-3 適用後は次の Step で PASS。

- [ ] **Step 5: テストが通ることを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml ensure_schema`
Expected: PASS（`ensure_schemaはghost_launchesテーブルを冪等に作る` 1 件）

- [ ] **Step 6: コミット**

```bash
git add src-tauri/src/db_path.rs src-tauri/src/commands/launch_history.rs src-tauri/src/commands/mod.rs
git commit -m "feat: user-data.db スキーマ・接続ヘルパーを追加 (#93)"
```

---

## Task 2: マイグレーション 12/13（集計列追加・旧履歴除去）（Rust, lib.rs）

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: migration 12（ghosts へ `last_launched TEXT` / `launch_count INTEGER NOT NULL DEFAULT 0` 追加）、migration 13（`DROP TABLE IF EXISTS ghost_launches`）。以降のタスクはこの 2 列に依存する。

- [ ] **Step 1: 失敗するテストを書く**

`src-tauri/src/lib.rs` の `tests` モジュール（`マイグレーションが順番に…` の隣）に追加:

```rust
    #[test]
    fn migration12と13で集計列追加と旧履歴テーブル除去が行われる() {
        let conn = Connection::open_in_memory().unwrap();
        let mut applied = migrations();
        applied.sort_by_key(|m| m.version);
        for m in applied {
            conn.execute_batch(m.sql).unwrap();
        }
        // ghosts に集計列が存在する
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(ghosts)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(cols.contains(&"last_launched".to_string()));
        assert!(cols.contains(&"launch_count".to_string()));
        // 旧 ghost_launches テーブルは ghosts.db から除去されている
        let has_launches: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='ghost_launches'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(has_launches, 0, "ghost_launches は user-data.db へ分離され ghosts.db からは除去される");
    }
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml migration12と13`
Expected: FAIL（`last_launched` 列なし / `ghost_launches` が残存）

- [ ] **Step 3: migration 12/13 を追加**

`migrations()` の `vec![ … ]` 内、version 11 の要素の**後ろ**に追加（末尾要素として）:

```rust
        tauri_plugin_sql::Migration {
            version: 12,
            description: "add_launch_aggregates_to_ghosts",
            sql: "ALTER TABLE ghosts ADD COLUMN last_launched TEXT;\nALTER TABLE ghosts ADD COLUMN launch_count INTEGER NOT NULL DEFAULT 0;",
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 13,
            description: "drop_legacy_ghost_launches_from_cache_db",
            sql: "DROP TABLE IF EXISTS ghost_launches;",
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml migration12と13`
Expected: PASS

- [ ] **Step 5: 既存マイグレーションテストの回帰確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml マイグレーション`
Expected: 全 PASS（`マイグレーションが順番にインメモリdbへ適用できる`・`ghost_viewの全選択列がghostsスキーマに存在する` 等が引き続き通る）

- [ ] **Step 6: コミット**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: migration 12/13 で集計列追加と旧履歴テーブル除去 (#93)"
```

---

## Task 3: record_launch の二面更新（Rust）

**Files:**
- Modify: `src-tauri/src/commands/launch_history.rs`

**Interfaces:**
- Consumes: `ensure_schema`（Task 1）、migration 12 の集計列（Task 2）
- Produces:
  - `commands::launch_history::record_launch_inner(user_conn: &Connection, ghosts_conn: &Connection, ghost_identity_key: &str) -> Result<(), String>`
  - テストヘルパー `ghosts_conn_with_row(identity_key: &str) -> Connection`（同ファイル `tests` 内。Task 4 でも再利用）

- [ ] **Step 1: 失敗するテストを書く**

`launch_history.rs` の `tests` モジュールに追加:

```rust
    fn ghosts_conn_with_row(identity_key: &str) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        let mut migs = crate::migrations();
        migs.sort_by_key(|m| m.version);
        for m in migs {
            conn.execute_batch(m.sql).unwrap();
        }
        conn.execute(
            "INSERT INTO ghosts (request_key, ghost_identity_key, row_fingerprint, name, sakura_name, kero_name, craftman, craftmanw, directory_name, path, source, name_lower, sakura_name_lower, kero_name_lower, craftman_lower, craftmanw_lower, directory_name_lower, thumbnail_path, thumbnail_use_self_alpha, thumbnail_kind, updated_at) VALUES ('rk1', ?1, '', 'G', '', '', '', '', 'g', '/g', 'ssp', 'g', '', '', '', '', 'g', '', 0, '', '')",
            rusqlite::params![identity_key],
        )
        .unwrap();
        conn
    }

    #[test]
    fn record_launch_innerはuserdataへinsertしghostsの集計列をbumpする() {
        let user_conn = Connection::open_in_memory().unwrap();
        ensure_schema(&user_conn).unwrap();
        let ghosts_conn = ghosts_conn_with_row("sspg");

        record_launch_inner(&user_conn, &ghosts_conn, "sspg").unwrap();
        record_launch_inner(&user_conn, &ghosts_conn, "sspg").unwrap();

        let launches: i64 = user_conn
            .query_row("SELECT COUNT(*) FROM ghost_launches WHERE ghost_identity_key = 'sspg'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(launches, 2);

        let (count, last): (i64, Option<String>) = ghosts_conn
            .query_row("SELECT launch_count, last_launched FROM ghosts WHERE ghost_identity_key = 'sspg'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(count, 2);
        assert!(last.is_some(), "last_launched が設定されること");
    }
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml record_launch_inner`
Expected: FAIL（`record_launch_inner` 未定義でコンパイルエラー）

- [ ] **Step 3: record_launch_inner を実装**

`launch_history.rs` の `open_user_data_db` の後に追加:

```rust
/// 起動履歴を記録する。user-data.db へ INSERT（権威）し、ghosts.db の集計列を bump（導出）する。
/// user-data 側を先に書くため、ghosts 側更新が失敗しても権威データは残り、次回バックフィルで整合する。
pub(crate) fn record_launch_inner(
    user_conn: &Connection,
    ghosts_conn: &Connection,
    ghost_identity_key: &str,
) -> Result<(), String> {
    user_conn
        .execute(
            "INSERT INTO ghost_launches (ghost_identity_key, launched_at) VALUES (?1, datetime('now'))",
            rusqlite::params![ghost_identity_key],
        )
        .map_err(|e| format!("起動履歴 INSERT エラー: {e}"))?;
    ghosts_conn
        .execute(
            "UPDATE ghosts SET launch_count = launch_count + 1, last_launched = datetime('now') WHERE ghost_identity_key = ?1",
            rusqlite::params![ghost_identity_key],
        )
        .map_err(|e| format!("集計列 UPDATE エラー: {e}"))?;
    Ok(())
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml record_launch_inner`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/commands/launch_history.rs
git commit -m "feat: record_launch_inner で起動履歴の二面更新を実装 (#93)"
```

---

## Task 4: 集計バックフィル（Rust）

**Files:**
- Modify: `src-tauri/src/commands/launch_history.rs`

**Interfaces:**
- Consumes: `ensure_schema`、テストヘルパー `ghosts_conn_with_row`（Task 3）
- Produces: `commands::launch_history::backfill_aggregates(ghosts_conn: &Connection, user_conn: &Connection) -> Result<(), String>`

- [ ] **Step 1: 失敗するテストを書く**

`tests` モジュールに追加（`ghosts_conn_with_row` は Task 3 で定義済みのものを再利用）:

```rust
    #[test]
    fn backfill_aggregatesはuserdataの集計をghostsへ再導出する() {
        let user_conn = Connection::open_in_memory().unwrap();
        ensure_schema(&user_conn).unwrap();
        let ghosts_conn = ghosts_conn_with_row("sspg");
        // 未起動の別ゴースト B も用意（0/NULL のままであること）
        ghosts_conn
            .execute(
                "INSERT INTO ghosts (request_key, ghost_identity_key, row_fingerprint, name, sakura_name, kero_name, craftman, craftmanw, directory_name, path, source, name_lower, sakura_name_lower, kero_name_lower, craftman_lower, craftmanw_lower, directory_name_lower, thumbnail_path, thumbnail_use_self_alpha, thumbnail_kind, updated_at) VALUES ('rk1', 'sspb', '', 'B', '', '', '', '', 'b', '/b', 'ssp', 'b', '', '', '', '', 'b', '', 0, '', '')",
                [],
            )
            .unwrap();
        // user-data に A の起動 3 回（時刻昇順）
        for at in ["2026-01-01 00:00:00", "2026-01-02 00:00:00", "2026-01-03 00:00:00"] {
            user_conn
                .execute("INSERT INTO ghost_launches (ghost_identity_key, launched_at) VALUES ('sspg', ?1)", rusqlite::params![at])
                .unwrap();
        }

        backfill_aggregates(&ghosts_conn, &user_conn).unwrap();

        let (count, last): (i64, Option<String>) = ghosts_conn
            .query_row("SELECT launch_count, last_launched FROM ghosts WHERE ghost_identity_key = 'sspg'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(count, 3);
        assert_eq!(last.as_deref(), Some("2026-01-03 00:00:00"));

        let (bcount, blast): (i64, Option<String>) = ghosts_conn
            .query_row("SELECT launch_count, last_launched FROM ghosts WHERE ghost_identity_key = 'sspb'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(bcount, 0);
        assert_eq!(blast, None);
    }
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml backfill_aggregates`
Expected: FAIL（`backfill_aggregates` 未定義）

- [ ] **Step 3: backfill_aggregates を実装**

`record_launch_inner` の後に追加:

```rust
/// user-data.db の起動履歴集計（identity 毎の MAX(launched_at) と COUNT）を
/// ghosts.db の集計列へ書き戻す。キャッシュ再構築（cache miss）の後に呼ぶ。
/// COUNT は単調増加のため、起動済みキーだけを上書きすれば未起動行は 0/NULL のまま残る。
pub(crate) fn backfill_aggregates(
    ghosts_conn: &Connection,
    user_conn: &Connection,
) -> Result<(), String> {
    let aggregates: Vec<(String, String, i64)> = {
        let mut stmt = user_conn
            .prepare("SELECT ghost_identity_key, MAX(launched_at), COUNT(*) FROM ghost_launches GROUP BY ghost_identity_key")
            .map_err(|e| format!("集計 SELECT 準備エラー: {e}"))?;
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|e| format!("集計 SELECT エラー: {e}"))?
            .filter_map(Result::ok)
            .collect()
    };
    for (key, last, count) in aggregates {
        ghosts_conn
            .execute(
                "UPDATE ghosts SET last_launched = ?2, launch_count = ?3 WHERE ghost_identity_key = ?1",
                rusqlite::params![key, last, count],
            )
            .map_err(|e| format!("集計列バックフィル UPDATE エラー: {e}"))?;
    }
    Ok(())
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml backfill_aggregates`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/commands/launch_history.rs
git commit -m "feat: backfill_aggregates で集計列を user-data から再導出 (#93)"
```

---

## Task 5: 旧履歴の一度きり移送（Rust）

**Files:**
- Modify: `src-tauri/src/commands/launch_history.rs`

**Interfaces:**
- Consumes: `ensure_schema`
- Produces:
  - `commands::launch_history::migrate_legacy_launch_history(ghosts_conn: &Connection, user_conn: &Connection) -> Result<(), String>`
  - テストヘルパー `ghosts_conn_with_legacy_launches(rows: &[(&str, &str)]) -> Connection`

- [ ] **Step 1: 失敗するテストを書く**

`tests` モジュールに追加:

```rust
    fn ghosts_conn_with_legacy_launches(rows: &[(&str, &str)]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // migration 11 相当の legacy テーブルのみ用意（本テストは移送だけを対象）
        conn.execute_batch(
            "CREATE TABLE ghost_launches (id INTEGER PRIMARY KEY AUTOINCREMENT, ghost_identity_key TEXT NOT NULL, launched_at TEXT NOT NULL);",
        )
        .unwrap();
        for (key, at) in rows {
            conn.execute("INSERT INTO ghost_launches (ghost_identity_key, launched_at) VALUES (?1, ?2)", rusqlite::params![key, at]).unwrap();
        }
        conn
    }

    #[test]
    fn migrate_legacyは旧履歴を複写し二度目は複写しない() {
        let user_conn = Connection::open_in_memory().unwrap();
        ensure_schema(&user_conn).unwrap();
        let ghosts_conn = ghosts_conn_with_legacy_launches(&[("sspg", "2026-01-01 00:00:00"), ("sspg", "2026-01-02 00:00:00")]);

        migrate_legacy_launch_history(&ghosts_conn, &user_conn).unwrap();
        // 冪等: 二度目は user-data が非空なので何もしない
        migrate_legacy_launch_history(&ghosts_conn, &user_conn).unwrap();

        let total: i64 = user_conn.query_row("SELECT COUNT(*) FROM ghost_launches", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 2, "重複複写されないこと");
    }

    #[test]
    fn migrate_legacyはlegacyテーブル不在でno_op() {
        let user_conn = Connection::open_in_memory().unwrap();
        ensure_schema(&user_conn).unwrap();
        let ghosts_conn = Connection::open_in_memory().unwrap(); // ghost_launches なし
        migrate_legacy_launch_history(&ghosts_conn, &user_conn).unwrap();
        let total: i64 = user_conn.query_row("SELECT COUNT(*) FROM ghost_launches", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 0);
    }
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml migrate_legacy`
Expected: FAIL（未定義）

- [ ] **Step 3: migrate_legacy_launch_history を実装**

`backfill_aggregates` の後に追加:

```rust
/// 旧 ghosts.db.ghost_launches の履歴を user-data.db へ一度だけ複写する。
/// 冪等ガード = user-data.db が空のときだけ複写する（二重複写を防ぐ）。
/// このため migration 13 による旧テーブル DROP の順序に依存せず安全。
pub(crate) fn migrate_legacy_launch_history(
    ghosts_conn: &Connection,
    user_conn: &Connection,
) -> Result<(), String> {
    let already: i64 = user_conn
        .query_row("SELECT COUNT(*) FROM ghost_launches", [], |r| r.get(0))
        .unwrap_or(0);
    if already > 0 {
        return Ok(());
    }
    let has_legacy: i64 = ghosts_conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'ghost_launches'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if has_legacy == 0 {
        return Ok(());
    }
    let legacy: Vec<(String, String)> = {
        let mut stmt = ghosts_conn
            .prepare("SELECT ghost_identity_key, launched_at FROM ghost_launches")
            .map_err(|e| format!("legacy SELECT 準備エラー: {e}"))?;
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| format!("legacy SELECT エラー: {e}"))?
            .filter_map(Result::ok)
            .collect()
    };
    for (key, at) in legacy {
        user_conn
            .execute(
                "INSERT INTO ghost_launches (ghost_identity_key, launched_at) VALUES (?1, ?2)",
                rusqlite::params![key, at],
            )
            .map_err(|e| format!("legacy 移送 INSERT エラー: {e}"))?;
    }
    Ok(())
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml migrate_legacy`
Expected: PASS（2 件）

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/commands/launch_history.rs
git commit -m "feat: 旧履歴を user-data.db へ一度きり冪等移送 (#93)"
```

---

## Task 6: record_launch コマンドと setup 配線（Rust, lib.rs）

**Files:**
- Modify: `src-tauri/src/commands/launch_history.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `open_user_data_db`（Task 1）, `record_launch_inner`（Task 3）, `migrate_legacy_launch_history`（Task 5）
- Produces: `#[tauri::command] commands::launch_history::record_launch(app, ghost_identity_key: String)`、`lib::init_user_data(app: &tauri::App)`

**注記（テスト方針）:** `record_launch` コマンドと `.setup()` 配線は `AppHandle` / `&App` を要し、この現場に単体テストの前例がない。ロジックは Task 3/5 の純関数テストで検証済み。本タスクは薄い配線のみで、検証は `cargo build` 通過＋統合検証（手動 E2E・手動アップグレード確認）に委ねる。追加配線のため TDD の Red は省略する。

- [ ] **Step 1: record_launch コマンドを追加**

`launch_history.rs` の `migrate_legacy_launch_history` の後（`#[cfg(test)]` の前）に追加:

```rust
/// 起動履歴を記録する Tauri コマンド。user-data.db へ INSERT し ghosts.db の集計列を bump する。
#[tauri::command]
pub fn record_launch(app: tauri::AppHandle, ghost_identity_key: String) -> Result<(), String> {
    let user_conn = open_user_data_db(&app)?;
    let ghosts_path = crate::db_path::ghost_db_path(&app)?;
    let ghosts_conn =
        Connection::open(&ghosts_path).map_err(|e| format!("ghosts.db オープンエラー: {e}"))?;
    crate::commands::ghost::store::configure_connection(&ghosts_conn)?;
    record_launch_inner(&user_conn, &ghosts_conn, &ghost_identity_key)
}
```

- [ ] **Step 2: lib.rs に user-data 初期化関数を追加**

`src-tauri/src/lib.rs` の `sanitize_ghost_db` 関数の後に追加:

```rust
/// user-data.db を初期化し、旧 ghosts.db.ghost_launches の履歴を一度だけ移送する。
/// Rust setup（JS の Database.load によるマイグレーションより先に走る）で呼ぶことで、
/// migration 13 の旧テーブル DROP より前に移送を完了させる。
fn init_user_data(app: &tauri::App) {
    let Ok(user_conn) = commands::launch_history::open_user_data_db(app) else {
        eprintln!("[user-data] user-data.db を初期化できませんでした");
        return;
    };
    let Ok(ghosts_path) = db_path::ghost_db_path(app) else {
        return;
    };
    // ghosts.db が存在するときだけ legacy 移送を試みる（空ファイルの事前生成を避ける）
    if ghosts_path.exists() {
        if let Ok(ghosts_conn) = rusqlite::Connection::open(&ghosts_path) {
            let _ = commands::launch_history::migrate_legacy_launch_history(&ghosts_conn, &user_conn);
        }
    }
}
```

- [ ] **Step 3: setup() で init_user_data を呼ぶ**

`.setup(|app| { … })` を更新:

```rust
        .setup(|app| {
            sanitize_ghost_db(app);
            init_user_data(app);
            Ok(())
        })
```

- [ ] **Step 4: invoke_handler に record_launch を登録**

`tauri::generate_handler![ … ]` を次へ:

```rust
        .invoke_handler(tauri::generate_handler![
            commands::db::reset_ghost_db,
            commands::ghost::scan_and_store,
            commands::launch_history::record_launch,
            commands::ssp::launch_ghost,
            commands::ssp::validate_ssp_path,
            commands::locale::read_user_locale,
        ])
```

- [ ] **Step 5: コンパイルとテスト全体の確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 全 PASS（配線がビルドを壊さない・既存 suite 緑）

- [ ] **Step 6: コミット**

```bash
git add src-tauri/src/commands/launch_history.rs src-tauri/src/lib.rs
git commit -m "feat: record_launch コマンドと user-data 初期化/移送を配線 (#93)"
```

---

## Task 7: scan_and_store にバックフィルを配線（Rust）

**Files:**
- Modify: `src-tauri/src/commands/ghost/mod.rs`

**Interfaces:**
- Consumes: `commands::launch_history::open_user_data_db`（Task 1）, `backfill_aggregates`（Task 4）

**注記（テスト方針）:** `scan_and_store` は `tauri::AppHandle` を取る `#[tauri::command]` で、この現場に単体テストの前例がない（バックフィルのロジックは Task 4 の純関数テストで検証済み）。本タスクは配線のみで、検証は `cargo test` の通過＋手動 E2E に委ねる。追加配線のため TDD の Red は省略する。

- [ ] **Step 1: cache miss 経路の末尾にバックフィルを追加**

`src-tauri/src/commands/ghost/mod.rs` の `scan_and_store` 内、`let total = store::store_ghosts(...)?;` の直後・`Ok(ScanStoreResult { … })` の前を次へ:

```rust
    let total = store::store_ghosts(&conn, &request_key, &ghosts, &fingerprint, &current_mtimes)?;

    // 起動履歴の集計列（last_launched / launch_count）を user-data.db から再導出する。
    // ベストエフォート: user-data.db を開けない場合も本来のスキャン結果は返す。
    if let Ok(user_conn) = crate::commands::launch_history::open_user_data_db(&app) {
        let _ = crate::commands::launch_history::backfill_aggregates(&conn, &user_conn);
    }

    Ok(ScanStoreResult {
        cache_hit: false,
        total,
        fingerprint,
        request_key,
    })
```

- [ ] **Step 2: コンパイルとテスト全体の確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 全 PASS

- [ ] **Step 3: コミット**

```bash
git add src-tauri/src/commands/ghost/mod.rs
git commit -m "feat: scan_and_store でスキャン後に集計列をバックフィル (#93)"
```

---

## Task 8: フロント recordLaunch を record_launch invoke へ（TS）

**Files:**
- Modify: `src/lib/ghostDatabase.ts`
- Modify: `src/lib/ghostDatabase.test.ts`

**Interfaces:**
- Produces: `recordLaunch(ghostIdentityKey: string): Promise<void>`（`invoke("record_launch", { ghostIdentityKey })` を呼ぶ）

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/ghostDatabase.test.ts` に追加（ファイル冒頭の import 群に `invoke` と `recordLaunch` が無ければ追加。重複 import は避ける）:

```ts
import { invoke } from "@tauri-apps/api/core";
import { recordLaunch } from "./ghostDatabase";

describe("recordLaunch", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it("record_launch IPC を camelCase 引数で呼ぶ", async () => {
    await recordLaunch("sspmy_ghost");
    expect(invoke).toHaveBeenCalledWith("record_launch", { ghostIdentityKey: "sspmy_ghost" });
  });
});
```

（`describe/it/expect/vi/beforeEach` は既存 import を利用。無ければ `import { describe, it, expect, vi, beforeEach } from "vitest";` を追加。）

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/lib/ghostDatabase.test.ts -t "record_launch IPC"`
Expected: FAIL（現行 `recordLaunch` は `getDb()` 経由で `db.execute` を呼ぶため `invoke("record_launch", …)` が呼ばれない）

- [ ] **Step 3: recordLaunch を invoke ベースへ書き換え**

`src/lib/ghostDatabase.ts` の `recordLaunch` を置換:

```ts
export async function recordLaunch(ghostIdentityKey: string): Promise<void> {
  await invoke("record_launch", { ghostIdentityKey });
}
```

（`invoke` はファイル冒頭で `import { invoke } from "@tauri-apps/api/core";` 済み。）

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/ghostDatabase.test.ts -t "record_launch IPC"`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/ghostDatabase.ts src/lib/ghostDatabase.test.ts
git commit -m "feat: recordLaunch を record_launch IPC 呼び出しへ移行 (#93)"
```

---

## Task 9: buildOrderBy の JOIN 廃止と集計列 ORDER BY（TS）

**Files:**
- Modify: `src/lib/ghostDatabase.ts`
- Modify: `src/lib/ghostDatabase.test.ts`

**Interfaces:**
- Produces: `buildOrderBy(sortOrder: SortOrder): string`（`{ orderBy, join }` から `string` へ縮退）

- [ ] **Step 1: 失敗するテストを書く**

`ghostDatabase.test.ts` に追加:

```ts
import { buildOrderBy } from "./ghostDatabase";

describe("buildOrderBy", () => {
  it("recent は JOIN なしで last_launched 列を並べる", () => {
    const orderBy = buildOrderBy("recent");
    expect(orderBy).toContain("g.last_launched DESC");
    expect(orderBy).not.toContain("JOIN");
    expect(orderBy).not.toContain("ghost_launches");
  });

  it("frequency は JOIN なしで launch_count 列を並べる", () => {
    const orderBy = buildOrderBy("frequency");
    expect(orderBy).toContain("g.launch_count DESC");
    expect(orderBy).not.toContain("JOIN");
  });

  it("name は name_lower を昇順で並べる", () => {
    expect(buildOrderBy("name")).toContain("g.name_lower ASC");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/lib/ghostDatabase.test.ts -t buildOrderBy`
Expected: FAIL（`buildOrderBy` は未 export、かつ現状 `{ orderBy, join }` を返す）

- [ ] **Step 3: buildOrderBy を string 返却へ・JOIN 廃止、呼び出し側を単純化**

`src/lib/ghostDatabase.ts` の `buildOrderBy` を置換:

```ts
// SELECT の ORDER BY 式を返す。recent/frequency は ghosts の非正規化集計列
// （last_launched / launch_count）で並べる。起動履歴は user-data.db（Rust 専有）に
// 分離され、集計列は record_launch とスキャン時バックフィルで維持される。
export function buildOrderBy(sortOrder: SortOrder): string {
  switch (sortOrder) {
    case "random":
      return `(g.id * ${randomSortSeed}) % ${RANDOM_SORT_MODULUS}, g.id`;
    case "recent":
      return "g.last_launched DESC NULLS LAST, g.name_lower ASC";
    case "frequency":
      return "g.launch_count DESC, g.name_lower ASC";
    default:
      return "g.name_lower ASC";
  }
}
```

`searchGhostsInitialPage` を更新（`join`/`from` 分岐を除去）:

```ts
export async function searchGhostsInitialPage(requestKey: string, limit: number, sortOrder: SortOrder = "name"): Promise<GhostView[]> {
  return measureSearch("searchGhostsInitialPage", async () => {
    const db = await getDb();
    const orderBy = buildOrderBy(sortOrder);
    const rows = await db.select<GhostView[]>(
      `SELECT ${GHOST_SELECT_COLUMNS_PREFIXED} FROM ghosts g WHERE g.request_key = ? ORDER BY ${orderBy} LIMIT ?`,
      [requestKey, limit]
    );

    console.log(`[ghostDatabase] searchGhostsInitialPage(requestKey=${requestKey}, limit=${limit}, sort=${sortOrder}) → rows=${rows.length}`);
    return rows;
  });
}
```

`searchGhosts` を更新（`join`/`from` 分岐を除去）:

```ts
export async function searchGhosts(requestKey: string, query: string, limit: number, offset: number, sortOrder: SortOrder = "name"): Promise<{ ghosts: GhostView[], total: number }> {
  return measureSearch("searchGhosts", async () => {
    const db = await getDb();

    const normalizedQuery = normalizeForKey(query);
    const likePattern = `%${normalizedQuery}%`;
    const orderBy = buildOrderBy(sortOrder);
    const searchWhere = GHOST_SEARCH_LOWER_COLUMNS.map((col) => `g.${col} LIKE ?`).join(" OR ");

    const [total, rows] = await Promise.all([
      countGhostsByQuery(requestKey, query),
      db.select<GhostView[]>(
        `SELECT ${GHOST_SELECT_COLUMNS_PREFIXED} FROM ghosts g WHERE g.request_key = ? AND (${searchWhere}) ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        [requestKey, ...GHOST_SEARCH_LOWER_COLUMNS.map(() => likePattern), limit, offset]
      ),
    ]);

    console.log(`[ghostDatabase] searchGhosts(requestKey=${requestKey}, query="${query}", limit=${limit}, offset=${offset}, sort=${sortOrder}) → total=${total}`);
    console.log(`[ghostDatabase] Fetched ${rows.length} rows`);
    return { ghosts: rows, total };
  });
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/ghostDatabase.test.ts -t buildOrderBy`
Expected: PASS

- [ ] **Step 5: フロント全体の型・テスト確認**

Run: `npm run build && npm test`
Expected: build 成功、全テスト PASS

- [ ] **Step 6: コミット**

```bash
git add src/lib/ghostDatabase.ts src/lib/ghostDatabase.test.ts
git commit -m "refactor: recent/frequency の cross-DB JOIN を集計列 ORDER BY へ置換 (#93)"
```

---

## Task 10: ドキュメント整合（コメント・CLAUDE.md・SPEC.md）

**Files:**
- Modify: `src-tauri/src/lib.rs`（`sanitize_ghost_db` の doc コメント）
- Modify: `src-tauri/CLAUDE.md`
- Modify: `SPEC.md`

**注記（テスト方針）:** ドキュメント・コメントのみの変更のため新規テストは追加しない（コミットメッセージに理由を明記）。

- [ ] **Step 1: sanitize_ghost_db の doc コメントを訂正**

`src-tauri/src/lib.rs` の `sanitize_ghost_db` 直上コメント末尾「DB ファイルを削除して再作成を促す。ghosts.db はキャッシュなので安全。」を次へ:

```rust
/// DB ファイルを削除して再作成を促す。ghosts.db は揮発キャッシュ（再スキャンで復旧）であり、
/// 永続的な起動履歴は user-data.db へ分離済みのため、削除しても失われない。
```

- [ ] **Step 2: src-tauri/CLAUDE.md の「安全」記述を訂正**

`src-tauri/CLAUDE.md` の「マイグレーションエラー自動回復」節、「ghosts.db の再作成でゴーストキャッシュは再スキャンで復旧するが、同居する永続テーブル `ghost_launches`（起動履歴）は失われる（改善検討は issue #93）。」を次へ置換:

```
ghosts.db は純粋キャッシュ（再スキャンで復旧）であり、永続的な起動履歴は `user-data.db`（Rust 専有・rusqlite、`commands/launch_history.rs`）へ分離済みのため、リセットで失われない。マイグレーションシステム外で `ALTER TABLE ADD COLUMN` を行ってはならない（マイグレーションと競合して起動不能になる）。
```

同ファイルの「永続テーブルのマイグレーション」節、`ghost_launches` を例に挙げた記述に「起動履歴は現在 `user-data.db` へ分離済み。将来の `favorites` 等の永続テーブルも user-data.db 側へ置き、揮発キャッシュ ghosts.db との運命共有を避ける」旨を追記する。

- [ ] **Step 3: SPEC.md を新構成へ同期**

`grep -n "ghost_launches\|キャッシュ DB\|再スキャンで復旧\|user-data\|LEFT JOIN" SPEC.md` で該当箇所を特定し、以下を更新:
- §4.5（永続テーブルのキー設計）: `ghost_launches` が `user-data.db`（Rust 専有）に住み、`ghosts` 側は非正規化集計列 `last_launched` / `launch_count` を持つ導出キャッシュであることを追記。
- §13（マイグレーション自動回復）: リセット対象は ghosts.db のみで、永続データ（user-data.db）は対象外である旨へ訂正。
- recent/frequency ソートを説明する節（§8.6 相当）: cross-DB JOIN 廃止と集計列 ORDER BY・維持機構（record_launch 即時更新／スキャン時バックフィル）を反映。
- DB 層を図示する節（§6.x / §9.2 mermaid 等）に user-data.db を追加し、ghosts.db=揮発・user-data.db=永続の二層を明示。

- [ ] **Step 4: ドキュメント検証**

Run: `grep -rn "同居する永続テーブル\|失われる（改善検討は issue #93）" src-tauri/CLAUDE.md`
Expected: 0 件（旧記述が残っていないこと）

Run: `npm run check:ui-guidelines`
Expected: PASS（コミット前チェックリストの一部として通す）

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/lib.rs src-tauri/CLAUDE.md SPEC.md
git commit -m "docs: 起動履歴の user-data.db 分離に伴い安全性記述を訂正 (#93)"
```

---

## 完了後の統合検証（PR 前）

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`（全 suite 緑）
- [ ] `npm test`（全 suite 緑）
- [ ] `npm run build`（型エラーなし）
- [ ] `npm run check:ui-guidelines` / `npm run test:ui-guidelines-check`
- [ ] `git status` が clean
- [ ] **E2E 手動実行**（`GHOST_LAUNCHER_E2E_APP` / `EDGEDRIVER_VERSION` 指定、メモリ参照）: ゴースト起動 → recent ソートで先頭化を確認。既知 flake（#90 スクロール stale）は main ベースライン比較で退行でないことを確認。
- [ ] **手動アップグレード確認**: 旧バージョンで起動履歴を作った ghosts.db を用意 → 新バイナリ起動後、履歴が user-data.db へ移送され recent/frequency が保持されること。DB リセット（migration 競合を模擬）後も履歴が残ること。
