use crate::descript::parse_descript;
use crate::thumbnail::{resolve_thumbnail, ThumbnailInfo};
use crate::GhostMetaError;
use std::fs;
use std::path::{Path, PathBuf};

/// ゴーストのメタデータ
pub struct GhostMeta {
    /// descript.txt の name フィールド（表示名）。未設定の場合はディレクトリ名
    pub name: String,
    /// descript.txt の sakura.name フィールド（\0 キャラ名）。未設定の場合は None
    pub sakura_name: Option<String>,
    /// descript.txt の kero.name フィールド（\1 キャラ名）。未設定の場合は None
    pub kero_name: Option<String>,
    /// descript.txt の craftman フィールド（作者名）。未設定の場合は None
    pub craftman: Option<String>,
    /// descript.txt の craftmanw フィールド（作者名2）。未設定の場合は None
    pub craftmanw: Option<String>,
    /// ゴーストのディレクトリ名
    pub directory_name: String,
    /// ゴーストルートディレクトリの絶対パス
    pub path: PathBuf,
    /// 解決済みサムネイル情報。thumbnail feature の有無に関わらず常に存在するフィールド
    pub thumbnail: Option<ThumbnailInfo>,
    /// ゴーストルートディレクトリの最終更新時刻（UNIX エポックナノ秒）。取得失敗時は 0
    pub dir_mtime_nanos: u128,
    /// descript.txt の状態。"present" / "missing" / "unreadable"
    pub descript_state: String,
    /// descript.txt の最終更新時刻（UNIX エポックナノ秒）。取得失敗または存在しない場合は None
    pub descript_mtime_nanos: Option<u128>,
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
    let sakura_name = fields.get("sakura.name").cloned();
    let kero_name = fields.get("kero.name").cloned();
    let craftman = fields.get("craftman").cloned();
    let craftmanw = fields.get("craftmanw").cloned();
    let thumbnail = resolve_thumbnail(ghost_root);

    let dir_mtime_nanos = fs::metadata(ghost_root)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let (descript_state, descript_mtime_nanos) = match fs::metadata(&descript_path) {
        Err(_) => ("missing".to_string(), None),
        Ok(meta) => {
            let nanos = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos());
            match nanos {
                Some(n) => ("present".to_string(), Some(n)),
                None => ("unreadable".to_string(), None),
            }
        }
    };

    Ok(GhostMeta {
        name,
        sakura_name,
        kero_name,
        craftman,
        craftmanw,
        directory_name,
        path: ghost_root.to_path_buf(),
        thumbnail,
        dir_mtime_nanos,
        descript_state,
        descript_mtime_nanos,
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
    use crate::testutil::TempDirGuard;

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
    fn read_ghost_がsakura_nameとkero_nameとcraftmanwを読み取る() {
        let tmp = TempDirGuard::new("ghost_meta_read_ghost_sakura_kero");
        create_ghost(
            tmp.path(),
            "full_ghost",
            "charset,UTF-8\nname,テストゴースト\nsakura.name,春菜\nkero.name,うにゅう\ncraftman,作者A\ncraftmanw,作者B\n",
        );

        let meta = read_ghost(&tmp.path().join("full_ghost")).unwrap();
        assert_eq!(meta.sakura_name, Some("春菜".to_string()));
        assert_eq!(meta.kero_name, Some("うにゅう".to_string()));
        assert_eq!(meta.craftman, Some("作者A".to_string()));
        assert_eq!(meta.craftmanw, Some("作者B".to_string()));
    }

    #[test]
    fn read_ghost_がsakura_name等なしのときnoneを返す() {
        let tmp = TempDirGuard::new("ghost_meta_read_ghost_no_sakura");
        create_ghost(tmp.path(), "minimal", "charset,UTF-8\nname,最小ゴースト\n");

        let meta = read_ghost(&tmp.path().join("minimal")).unwrap();
        assert_eq!(meta.sakura_name, None);
        assert_eq!(meta.kero_name, None);
        assert_eq!(meta.craftmanw, None);
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

    // --- mtime フィールド ---

    #[test]
    fn read_ghost_がdir_mtime_nanosを返す() {
        let tmp = TempDirGuard::new("ghost_meta_dir_mtime");
        create_ghost(tmp.path(), "my_ghost", "charset,UTF-8\nname,Test\n");

        let meta = read_ghost(&tmp.path().join("my_ghost")).unwrap();
        assert!(meta.dir_mtime_nanos > 0);
    }

    #[test]
    fn read_ghost_がdescript_stateをpresentで返す() {
        let tmp = TempDirGuard::new("ghost_meta_descript_state_present");
        create_ghost(tmp.path(), "my_ghost", "charset,UTF-8\nname,Test\n");

        let meta = read_ghost(&tmp.path().join("my_ghost")).unwrap();
        assert_eq!(meta.descript_state, "present");
        assert!(meta.descript_mtime_nanos.is_some());
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
