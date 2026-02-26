// mod.rs
mod fingerprint;
mod path_utils;
mod scan;
mod types;

pub use types::{Ghost, ScanGhostsResponse};

#[tauri::command]
pub fn scan_ghosts_with_meta(
    ssp_path: String,
    additional_folders: Vec<String>,
) -> Result<ScanGhostsResponse, String> {
    let (ghosts, fingerprint) =
        scan::scan_ghosts_with_fingerprint_internal(&ssp_path, &additional_folders)?;
    Ok(ScanGhostsResponse {
        ghosts,
        fingerprint,
    })
}

#[tauri::command]
pub fn get_ghosts_fingerprint(
    ssp_path: String,
    additional_folders: Vec<String>,
) -> Result<String, String> {
    fingerprint::build_fingerprint(&ssp_path, &additional_folders)
}

#[cfg(test)]
mod tests {
    use super::fingerprint::build_fingerprint;
    use super::scan::{scan_ghosts_with_fingerprint_internal, unique_sorted_additional_folders};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDirGuard {
        path: PathBuf,
    }

    impl TempDirGuard {
        fn new(prefix: &str) -> Result<Self, String> {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| format!("failed to get time: {}", error))?
                .as_nanos();
            let path = std::env::temp_dir().join(format!("{}_{}", prefix, now));
            fs::create_dir_all(&path).map_err(|error| {
                format!("failed to create temp dir {}: {}", path.display(), error)
            })?;
            Ok(Self { path })
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

    fn create_ghost_dir(root: &PathBuf, name: &str) -> Result<(), String> {
        create_ghost_dir_with_descript(root, name, "name,Test Ghost\ncharset,UTF-8\n")
    }

    fn create_ghost_dir_with_descript(
        root: &PathBuf,
        name: &str,
        descript: &str,
    ) -> Result<(), String> {
        let base = root.join(name).join("ghost").join("master");
        fs::create_dir_all(&base)
            .map_err(|error| format!("failed to create ghost dir {}: {}", base.display(), error))?;
        fs::write(base.join("descript.txt"), descript)
            .map_err(|error| format!("failed to write descript: {}", error))
    }

    #[test]
    fn unique_sorted_additional_folders_dedupes_by_normalized_path() {
        let folders = vec![
            "C:\\Ghosts\\Extra".to_string(),
            "c:/ghosts/extra".to_string(),
            "C:/Ghosts/Another".to_string(),
        ];

        let actual = unique_sorted_additional_folders(&folders);

        assert_eq!(actual.len(), 2);
        assert_eq!(actual[0].2, "c:/ghosts/another");
        assert_eq!(actual[1].2, "c:/ghosts/extra");
    }

    #[test]
    fn build_fingerprint_is_order_independent_for_additional_folders() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_fingerprint_test")?;
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost)
            .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
        create_ghost_dir(&ssp_ghost, "base_ghost")?;

        let additional_a = workspace.path().join("additional_a");
        let additional_b = workspace.path().join("additional_b");
        fs::create_dir_all(&additional_a)
            .map_err(|error| format!("failed to create additional_a: {}", error))?;
        fs::create_dir_all(&additional_b)
            .map_err(|error| format!("failed to create additional_b: {}", error))?;
        create_ghost_dir(&additional_a, "extra_ghost_a")?;
        create_ghost_dir(&additional_b, "extra_ghost_b")?;

        let ordered = vec![
            additional_a.to_string_lossy().to_string(),
            additional_b.to_string_lossy().to_string(),
        ];
        let reversed = vec![
            additional_b.to_string_lossy().to_string(),
            additional_a.to_string_lossy().to_string(),
        ];

        let fingerprint_ordered = build_fingerprint(&ssp_root.to_string_lossy(), &ordered)?;
        let fingerprint_reversed = build_fingerprint(&ssp_root.to_string_lossy(), &reversed)?;

        assert_eq!(fingerprint_ordered, fingerprint_reversed);
        Ok(())
    }

    #[test]
    fn scan_ghosts_internal_collects_sources_and_sorts_by_name() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_scan_test")?;
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost)
            .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
        create_ghost_dir_with_descript(&ssp_ghost, "ssp_dir", "name,zulu\ncharset,UTF-8\n")?;

        let additional_a = workspace.path().join("additional_a");
        let additional_b = workspace.path().join("additional_b");
        fs::create_dir_all(&additional_a)
            .map_err(|error| format!("failed to create additional_a: {}", error))?;
        fs::create_dir_all(&additional_b)
            .map_err(|error| format!("failed to create additional_b: {}", error))?;
        create_ghost_dir_with_descript(&additional_a, "extra_a", "name,Alpha\ncharset,UTF-8\n")?;
        create_ghost_dir_with_descript(&additional_b, "extra_b", "name,bravo\ncharset,UTF-8\n")?;

        let additional_paths = vec![
            additional_b.to_string_lossy().to_string(),
            additional_a.to_string_lossy().to_string(),
        ];
        let (ghosts, _) =
            scan_ghosts_with_fingerprint_internal(&ssp_root.to_string_lossy(), &additional_paths)?;

        assert_eq!(ghosts.len(), 3);
        assert_eq!(ghosts[0].name, "Alpha");
        assert_eq!(ghosts[1].name, "bravo");
        assert_eq!(ghosts[2].name, "zulu");

        let ssp_ghost_item = ghosts
            .iter()
            .find(|ghost| ghost.directory_name == "ssp_dir")
            .ok_or_else(|| "ssp ghost not found".to_string())?;
        assert_eq!(ssp_ghost_item.source, "ssp");

        let extra_a = ghosts
            .iter()
            .find(|ghost| ghost.directory_name == "extra_a")
            .ok_or_else(|| "extra_a ghost not found".to_string())?;
        assert_eq!(extra_a.source, additional_a.to_string_lossy());

        let extra_b = ghosts
            .iter()
            .find(|ghost| ghost.directory_name == "extra_b")
            .ok_or_else(|| "extra_b ghost not found".to_string())?;
        assert_eq!(extra_b.source, additional_b.to_string_lossy());

        Ok(())
    }

    #[test]
    fn scan_ghosts_internal_falls_back_to_directory_name_without_name_field() -> Result<(), String>
    {
        let workspace = TempDirGuard::new("ghost_launcher_scan_fallback_test")?;
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost)
            .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
        create_ghost_dir_with_descript(
            &ssp_ghost,
            "fallback_dir",
            "charset,UTF-8\n// no name field\n",
        )?;

        let (ghosts, _) = scan_ghosts_with_fingerprint_internal(&ssp_root.to_string_lossy(), &[])?;
        let fallback = ghosts
            .iter()
            .find(|ghost| ghost.directory_name == "fallback_dir")
            .ok_or_else(|| "fallback ghost not found".to_string())?;
        assert_eq!(fallback.name, "fallback_dir");
        assert_eq!(fallback.source, "ssp");
        Ok(())
    }

    #[test]
    fn scan_ghosts_internal_returns_error_when_ssp_ghost_dir_is_missing() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_missing_ghost_dir_test")?;
        let ssp_root = workspace.path().join("ssp_without_ghost");
        fs::create_dir_all(&ssp_root)
            .map_err(|error| format!("failed to create ssp root dir: {}", error))?;

        let result = scan_ghosts_with_fingerprint_internal(&ssp_root.to_string_lossy(), &[]);
        assert!(result.is_err());
        let error = result.err().ok_or_else(|| "expected error".to_string())?;
        assert!(error.contains("ghost フォルダが見つかりません"));
        Ok(())
    }

    #[test]
    fn fingerprint_with_missing_additional_folder_matches_scan_fingerprint() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_missing_folder_fp_test")?;
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost)
            .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
        create_ghost_dir(&ssp_ghost, "test_ghost")?;

        // 存在しない追加フォルダ（missing ケース）
        let nonexistent = workspace.path().join("nonexistent_folder");
        // 存在するがファイル（not-directory ケース）
        let not_a_dir = workspace.path().join("not_a_dir.txt");
        fs::write(&not_a_dir, "").map_err(|error| format!("failed to create file: {}", error))?;

        let additional_folders = vec![
            nonexistent.to_string_lossy().to_string(),
            not_a_dir.to_string_lossy().to_string(),
        ];
        let ssp_path = ssp_root.to_string_lossy().to_string();

        let standalone = build_fingerprint(&ssp_path, &additional_folders)?;
        let (_, integrated) =
            scan_ghosts_with_fingerprint_internal(&ssp_path, &additional_folders)?;

        assert_eq!(standalone, integrated);
        Ok(())
    }

    #[test]
    fn integrated_fingerprint_matches_standalone_build_fingerprint() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_fp_consistency_test")?;
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost)
            .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
        create_ghost_dir(&ssp_ghost, "ghost_a")?;
        create_ghost_dir(&ssp_ghost, "ghost_b")?;

        let additional = workspace.path().join("additional");
        fs::create_dir_all(&additional)
            .map_err(|error| format!("failed to create additional: {}", error))?;
        create_ghost_dir(&additional, "extra_ghost")?;

        let additional_folders = vec![additional.to_string_lossy().to_string()];
        let ssp_path = ssp_root.to_string_lossy().to_string();

        let standalone = build_fingerprint(&ssp_path, &additional_folders)?;
        let (_, integrated) =
            scan_ghosts_with_fingerprint_internal(&ssp_path, &additional_folders)?;

        assert_eq!(standalone, integrated);
        Ok(())
    }
}
