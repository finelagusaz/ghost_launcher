use crate::descript::parse_descript;
use crate::thumbnail::{resolve_thumbnail, ThumbnailInfo};
use crate::GhostMetaError;
use std::fs;
use std::path::{Path, PathBuf};

/// ゴーストのメタデータ
pub struct GhostMeta {
    /// descript.txt の name フィールド（表示名）。未設定の場合はディレクトリ名
    pub name: String,
    /// descript.txt の craftman フィールド（作者名）。未設定の場合は None
    pub craftman: Option<String>,
    /// ゴーストのディレクトリ名
    pub directory_name: String,
    /// ゴーストルートディレクトリの絶対パス
    pub path: PathBuf,
    /// 解決済みサムネイル情報。thumbnail feature の有無に関わらず常に存在するフィールド
    pub thumbnail: Option<ThumbnailInfo>,
}

/// ゴーストルートディレクトリのメタデータを取得する。
/// ghost_root は `{parent}/{ghost_name}` に相当するディレクトリ。
/// descript.txt のパスは `ghost_root/ghost/master/descript.txt`。
pub fn read_ghost(ghost_root: &Path) -> Result<GhostMeta, GhostMetaError> {
    let directory_name = ghost_root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let descript_path = ghost_root.join("ghost").join("master").join("descript.txt");
    let fields = parse_descript(&descript_path)?;

    let name = fields
        .get("name")
        .cloned()
        .unwrap_or_else(|| directory_name.clone());
    let craftman = fields.get("craftman").cloned();
    let thumbnail = resolve_thumbnail(ghost_root);

    Ok(GhostMeta {
        name,
        craftman,
        directory_name,
        path: ghost_root.to_path_buf(),
        thumbnail,
    })
}

/// parent_dir 配下のゴーストを走査して全メタデータを返す。
/// descript.txt が存在しないエントリはスキップする。
/// parent_dir の read_dir に失敗した場合はエラーを返す。
pub fn scan_ghosts(parent_dir: &Path) -> Result<Vec<GhostMeta>, GhostMetaError> {
    let mut ghosts = Vec::new();

    for entry in fs::read_dir(parent_dir)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // descript.txt が存在するエントリのみ Ghost として扱う
        if let Ok(meta) = read_ghost(&path) {
            ghosts.push(meta);
        }
    }

    Ok(ghosts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDirGuard {
        path: PathBuf,
    }

    impl TempDirGuard {
        fn new(prefix: &str) -> Self {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("{}_{}", prefix, now));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn path(&self) -> &PathBuf {
            &self.path
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn create_ghost(root: &PathBuf, dir_name: &str, descript: &str) {
        let base = root.join(dir_name).join("ghost").join("master");
        fs::create_dir_all(&base).unwrap();
        fs::write(base.join("descript.txt"), descript).unwrap();
    }

    // --- read_ghost ---

    #[test]
    fn read_ghost_がnameとcraftmanを読み取る() {
        let tmp = TempDirGuard::new("ghost_meta_read_ghost");
        create_ghost(
            tmp.path(),
            "my_ghost",
            "charset,UTF-8\nname,テストゴースト\ncraftman,作者名\n",
        );

        let meta = read_ghost(&tmp.path().join("my_ghost")).unwrap();
        assert_eq!(meta.name, "テストゴースト");
        assert_eq!(meta.craftman, Some("作者名".to_string()));
        assert_eq!(meta.directory_name, "my_ghost");
    }

    #[test]
    fn read_ghost_がnameなしのときディレクトリ名にフォールバックする() {
        let tmp = TempDirGuard::new("ghost_meta_read_ghost_fallback");
        create_ghost(tmp.path(), "fallback_dir", "charset,UTF-8\n");

        let meta = read_ghost(&tmp.path().join("fallback_dir")).unwrap();
        assert_eq!(meta.name, "fallback_dir");
    }

    #[test]
    fn read_ghost_がcraftmanなしのときnoneを返す() {
        let tmp = TempDirGuard::new("ghost_meta_read_ghost_no_craftman");
        create_ghost(tmp.path(), "no_craftman", "charset,UTF-8\nname,作者なし\n");

        let meta = read_ghost(&tmp.path().join("no_craftman")).unwrap();
        assert_eq!(meta.craftman, None);
    }

    #[test]
    fn read_ghost_がdescripttxtなしのときioエラーを返す() {
        let tmp = TempDirGuard::new("ghost_meta_read_ghost_missing");
        fs::create_dir_all(tmp.path().join("no_descript").join("ghost").join("master")).unwrap();

        let result = read_ghost(&tmp.path().join("no_descript"));
        assert!(matches!(result, Err(GhostMetaError::Io(_))));
    }

    // --- scan_ghosts ---

    #[test]
    fn scan_ghosts_が複数ゴーストを返す() {
        let tmp = TempDirGuard::new("ghost_meta_scan_multi");
        create_ghost(tmp.path(), "ghost_a", "charset,UTF-8\nname,Alpha\n");
        create_ghost(tmp.path(), "ghost_b", "charset,UTF-8\nname,Beta\n");

        let mut metas = scan_ghosts(tmp.path()).unwrap();
        metas.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(metas.len(), 2);
        assert_eq!(metas[0].name, "Alpha");
        assert_eq!(metas[1].name, "Beta");
    }

    #[test]
    fn scan_ghosts_がdescripttxtなしのエントリをスキップする() {
        let tmp = TempDirGuard::new("ghost_meta_scan_skip");
        // descript.txt あり
        create_ghost(tmp.path(), "valid_ghost", "charset,UTF-8\nname,Valid\n");
        // descript.txt なし（ディレクトリのみ）
        fs::create_dir_all(tmp.path().join("empty_dir")).unwrap();

        let metas = scan_ghosts(tmp.path()).unwrap();
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].name, "Valid");
    }

    #[test]
    fn scan_ghosts_が空ディレクトリで空vecを返す() {
        let tmp = TempDirGuard::new("ghost_meta_scan_empty");
        let metas = scan_ghosts(tmp.path()).unwrap();
        assert!(metas.is_empty());
    }

    #[test]
    fn scan_ghosts_が存在しないディレクトリでioエラーを返す() {
        let result = scan_ghosts(Path::new("/nonexistent/path"));
        assert!(matches!(result, Err(GhostMetaError::Io(_))));
    }

    #[test]
    fn scan_ghosts_がファイルエントリをスキップする() {
        let tmp = TempDirGuard::new("ghost_meta_scan_files");
        create_ghost(tmp.path(), "valid_ghost", "charset,UTF-8\nname,Valid\n");
        // ファイル（ディレクトリではない）
        fs::write(tmp.path().join("some_file.txt"), "").unwrap();

        let metas = scan_ghosts(tmp.path()).unwrap();
        assert_eq!(metas.len(), 1);
    }

    // --- thumbnail フィールド統合 ---

    #[test]
    fn read_ghost_がsurface0あり時にthumbnailを返す() {
        let tmp = TempDirGuard::new("ghost_meta_read_ghost_thumb");
        create_ghost(tmp.path(), "with_shell", "charset,UTF-8\nname,With Shell\n");
        // shell/master/surface0.png を作成
        let shell_master = tmp.path().join("with_shell").join("shell").join("master");
        fs::create_dir_all(&shell_master).unwrap();
        fs::write(shell_master.join("surface0.png"), "").unwrap();

        let meta = read_ghost(&tmp.path().join("with_shell")).unwrap();
        assert!(meta.thumbnail.is_some());
        assert_eq!(
            meta.thumbnail.unwrap().path,
            shell_master.join("surface0.png")
        );
    }

    #[test]
    fn read_ghost_がshellなし時にthumbnailはnone() {
        let tmp = TempDirGuard::new("ghost_meta_read_ghost_no_thumb");
        create_ghost(tmp.path(), "no_shell", "charset,UTF-8\nname,No Shell\n");

        let meta = read_ghost(&tmp.path().join("no_shell")).unwrap();
        assert!(meta.thumbnail.is_none());
    }
}
