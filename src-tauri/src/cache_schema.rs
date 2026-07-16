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
