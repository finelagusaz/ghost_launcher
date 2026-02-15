use crate::utils::descript;
use std::fs;
use std::path::{Path, PathBuf};

use super::path_utils::normalize_path;
use super::types::Ghost;

pub(crate) fn unique_sorted_additional_folders(
    additional_folders: &[String],
) -> Vec<(String, PathBuf, String)> {
    let mut folders = additional_folders
        .iter()
        .map(|folder| {
            let path = PathBuf::from(folder);
            let normalized = normalize_path(&path);
            (folder.clone(), path, normalized)
        })
        .collect::<Vec<_>>();

    folders.sort_by(|a, b| a.2.cmp(&b.2));
    folders.dedup_by(|a, b| a.2 == b.2);
    folders
}

fn scan_ghost_dir(parent_dir: &Path, source: &str) -> Result<Vec<Ghost>, String> {
    let mut ghosts = Vec::new();

    let entries = fs::read_dir(parent_dir).map_err(|e| {
        format!(
            "ディレクトリを読み取れませんでした ({}): {}",
            parent_dir.display(),
            e
        )
    })?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let directory_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };

        let descript_path = path.join("ghost").join("master").join("descript.txt");
        let fields = match descript::parse_descript(&descript_path) {
            Ok(f) => f,
            Err(_) => continue,
        };

        let name = fields
            .get("name")
            .cloned()
            .unwrap_or_else(|| directory_name.clone());

        ghosts.push(Ghost {
            name,
            directory_name,
            path: path.to_string_lossy().into_owned(),
            source: source.to_string(),
        });
    }

    Ok(ghosts)
}

pub(crate) fn scan_ghosts_internal(
    ssp_path: &str,
    additional_folders: &[String],
) -> Result<Vec<Ghost>, String> {
    let ghost_dir = Path::new(ssp_path).join("ghost");
    if !ghost_dir.exists() {
        return Err(format!(
            "ghost フォルダが見つかりません: {}",
            ghost_dir.display()
        ));
    }
    if !ghost_dir.is_dir() {
        return Err(format!(
            "ghost フォルダがディレクトリではありません: {}",
            ghost_dir.display()
        ));
    }

    let mut ghosts = scan_ghost_dir(&ghost_dir, "ssp")?;

    for (source, folder_path, _) in unique_sorted_additional_folders(additional_folders) {
        if folder_path.is_dir() {
            if let Ok(mut additional) = scan_ghost_dir(&folder_path, &source) {
                ghosts.append(&mut additional);
            }
        }
    }

    ghosts.sort_by_cached_key(|ghost| ghost.name.to_lowercase());
    Ok(ghosts)
}
