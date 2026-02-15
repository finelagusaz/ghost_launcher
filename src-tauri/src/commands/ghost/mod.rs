mod fingerprint;
mod path_utils;
mod scan;
mod types;

pub use types::{Ghost, ScanGhostsResponse};

#[tauri::command]
pub fn scan_ghosts(ssp_path: String, additional_folders: Vec<String>) -> Result<Vec<Ghost>, String> {
    scan::scan_ghosts_internal(&ssp_path, &additional_folders)
}

#[tauri::command]
pub fn scan_ghosts_with_meta(
    ssp_path: String,
    additional_folders: Vec<String>,
) -> Result<ScanGhostsResponse, String> {
    let ghosts = scan::scan_ghosts_internal(&ssp_path, &additional_folders)?;
    let fingerprint = fingerprint::build_fingerprint(&ssp_path, &additional_folders)?;
    Ok(ScanGhostsResponse { ghosts, fingerprint })
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
    use super::scan::unique_sorted_additional_folders;
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
            fs::create_dir_all(&path)
                .map_err(|error| format!("failed to create temp dir {}: {}", path.display(), error))?;
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
        let base = root.join(name).join("ghost").join("master");
        fs::create_dir_all(&base)
            .map_err(|error| format!("failed to create ghost dir {}: {}", base.display(), error))?;
        fs::write(base.join("descript.txt"), "name,Test Ghost\ncharset,UTF-8\n")
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
}
