/// 現行キャッシュスキーマを適用する（テスト用 DB 初期化の単一ヘルパー）。
/// 旧 apply_all_migrations の後継。migration 由来ではなく CACHE_SCHEMA が単一権威。
pub(crate) fn apply_cache_schema(conn: &rusqlite::Connection) {
    conn.execute_batch(crate::cache_schema::CACHE_SCHEMA)
        .unwrap_or_else(|e| panic!("cache schema の適用に失敗: {e}"));
}

/// ghosts テーブルへ最小構成の 1 行を seed する（集計列 bump 観測などのテスト用）。
pub(crate) fn insert_ghost_row(conn: &rusqlite::Connection, identity_key: &str) {
    conn.execute(
        "INSERT INTO ghosts (request_key, ghost_identity_key, row_fingerprint, name, sakura_name, kero_name, craftman, craftmanw, directory_name, path, source, name_lower, sakura_name_lower, kero_name_lower, craftman_lower, craftmanw_lower, directory_name_lower, thumbnail_path, thumbnail_use_self_alpha, thumbnail_kind, updated_at) VALUES ('rk1', ?1, '', 'G', '', '', '', '', 'g', '/g', 'ssp', 'g', '', '', '', '', 'g', '', 0, '', '')",
        rusqlite::params![identity_key],
    )
    .unwrap();
}

/// テスト用の一時ディレクトリ。Drop 時に自動削除される。
pub(crate) struct TempDirGuard {
    path: std::path::PathBuf,
}

impl TempDirGuard {
    pub(crate) fn new(prefix: &str) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("{}_{}", prefix, now));
        std::fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    pub(crate) fn path(&self) -> &std::path::PathBuf {
        &self.path
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
