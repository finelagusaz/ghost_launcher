/// 全マイグレーションを version 昇順で適用する（テスト用 DB 初期化の単一ヘルパー）。
/// 部分適用（`take(n)`・version フィルタ）が要るテストは対象外で、各自ループを書く。
pub(crate) fn apply_all_migrations(conn: &rusqlite::Connection) {
    let mut sorted = crate::migrations();
    sorted.sort_by_key(|m| m.version);
    for m in &sorted {
        conn.execute_batch(m.sql).unwrap_or_else(|e| {
            panic!("migration {} ({}) failed: {}", m.version, m.description, e)
        });
    }
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
