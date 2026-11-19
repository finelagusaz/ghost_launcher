//! 試験とベンチが共有する一時ディレクトリのガード。試験からは `testutil` 経由で、
//! ベンチからは `bench_support` の再エクスポート経由で使う（本番ではコンパイルしない）。

/// 一時ディレクトリ。OS の一時ディレクトリの下に作り、Drop 時に自動削除する。
pub struct TempDirGuard {
    path: std::path::PathBuf,
}

impl TempDirGuard {
    /// `{OS の一時ディレクトリ}/{prefix}_{ナノ秒}` を作る。
    pub fn new(prefix: &str) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("{}_{}", prefix, now));
        std::fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    pub fn path(&self) -> &std::path::PathBuf {
        &self.path
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
