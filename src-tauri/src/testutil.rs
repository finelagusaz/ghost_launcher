/// 現行キャッシュスキーマを適用する（テスト用 DB 初期化の単一ヘルパー）。
/// 旧 apply_all_migrations の後継。migration 由来ではなく CACHE_SCHEMA が単一権威。
pub(crate) fn apply_cache_schema(conn: &rusqlite::Connection) {
    conn.execute_batch(crate::cache_schema::CACHE_SCHEMA)
        .unwrap_or_else(|e| panic!("cache schema の適用に失敗: {e}"));
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
