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

/// scan と fingerprint を 2 パスで実行する統合関数。
/// ゴーストメタデータは ghost-meta クレートに、フィンガープリント計算は fingerprint モジュールに委譲する。
pub(crate) fn scan_ghosts_with_fingerprint_internal(
    ssp_path: &str,
    additional_folders: &[String],
) -> Result<(Vec<Ghost>, String), String> {
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

    // SSP ゴーストをスキャン
    let mut ghosts: Vec<Ghost> = ghost_meta::scan_ghosts(&ghost_dir)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|meta| Ghost {
            name: meta.name,
            craftman: meta.craftman.unwrap_or_default(),
            directory_name: meta.directory_name,
            path: meta.path.to_string_lossy().into_owned(),
            source: "ssp".to_string(),
        })
        .collect();

    // 追加フォルダをスキャン
    for (source, folder_path, _) in unique_sorted_additional_folders(additional_folders) {
        if !folder_path.exists() || !folder_path.is_dir() {
            continue;
        }
        if let Ok(metas) = ghost_meta::scan_ghosts(&folder_path) {
            ghosts.extend(metas.into_iter().map(|meta| Ghost {
                name: meta.name,
                craftman: meta.craftman.unwrap_or_default(),
                directory_name: meta.directory_name,
                path: meta.path.to_string_lossy().into_owned(),
                source: source.clone(),
            }));
        }
    }

    ghosts.sort_by_cached_key(|ghost| ghost.name.to_lowercase());

    // フィンガープリント計算（fingerprint モジュールに委譲）
    let fingerprint = super::fingerprint::build_fingerprint(ssp_path, additional_folders)?;

    Ok((ghosts, fingerprint))
}
