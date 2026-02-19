use crate::utils::descript;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
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

/// fs::metadata から更新時刻の nanos 文字列を取得するヘルパー
fn metadata_modified_string(meta: &fs::Metadata) -> String {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos().to_string())
        .unwrap_or_else(|| "unreadable".to_string())
}

/// ゴーストディレクトリを走査し、Ghost データとフィンガープリントトークンを同時収集する
/// required=true の場合、read_dir 失敗でエラーを返す（SSP 用）
/// required=false の場合、read_dir 失敗でもトークンを追加して正常終了（追加フォルダ用）
fn scan_ghost_dir_with_fingerprint(
    parent_dir: &Path,
    source: &str,
    parent_label: &str,
    normalized_parent: &str,
    tokens: &mut Vec<String>,
    required: bool,
) -> Result<Vec<Ghost>, String> {
    let mut ghosts = Vec::new();

    // 親ディレクトリの modified time（fingerprint 用）
    let parent_modified = fs::metadata(parent_dir)
        .as_ref()
        .map(metadata_modified_string)
        .unwrap_or_else(|_| "unreadable".to_string());
    tokens.push(format!(
        "parent|{}|{}|{}",
        parent_label, normalized_parent, parent_modified
    ));

    let entries = match fs::read_dir(parent_dir) {
        Ok(entries) => entries,
        Err(error) => {
            if required {
                return Err(format!(
                    "ディレクトリを読み取れませんでした ({}): {}",
                    parent_dir.display(),
                    error
                ));
            }
            tokens.push(format!(
                "entries|{}|{}|unreadable",
                parent_label, normalized_parent
            ));
            return Ok(ghosts);
        }
    };

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

        // ディレクトリの modified time（fingerprint 用）
        let dir_modified = fs::metadata(&path)
            .as_ref()
            .map(metadata_modified_string)
            .unwrap_or_else(|_| "unreadable".to_string());

        // descript.txt: metadata 1回で存在確認 + modified time（fingerprint 用）
        let descript_path = path.join("ghost").join("master").join("descript.txt");
        let (descript_state, descript_modified, descript_exists) = match fs::metadata(&descript_path)
        {
            Err(_) => ("missing".to_string(), "-".to_string(), false),
            Ok(meta) => {
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos());
                match modified {
                    Some(nanos) => ("present".to_string(), nanos.to_string(), true),
                    None => ("unreadable".to_string(), "-".to_string(), true),
                }
            }
        };

        tokens.push(format!(
            "entry|{}|{}|{}|{}|{}|{}",
            parent_label,
            normalized_parent,
            directory_name,
            dir_modified,
            descript_state,
            descript_modified
        ));

        // descript.txt が存在する場合のみパースして Ghost を構築
        if descript_exists {
            if let Ok(fields) = descript::parse_descript(&descript_path) {
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
        }
    }

    Ok(ghosts)
}

/// scan と fingerprint を単一走査で実行する統合関数
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

    let mut tokens = vec!["fingerprint-version|1".to_string()];
    let normalized_ssp = normalize_path(&ghost_dir);

    let mut ghosts =
        scan_ghost_dir_with_fingerprint(&ghost_dir, "ssp", "ssp", &normalized_ssp, &mut tokens, true)?;

    for (source, folder_path, normalized_folder) in unique_sorted_additional_folders(additional_folders) {
        if !folder_path.exists() {
            tokens.push(format!(
                "parent|{}|{}|missing",
                normalized_folder, normalized_folder
            ));
            continue;
        }
        if !folder_path.is_dir() {
            tokens.push(format!(
                "parent|{}|{}|not-directory",
                normalized_folder, normalized_folder
            ));
            continue;
        }
        if let Ok(mut additional) = scan_ghost_dir_with_fingerprint(
            &folder_path,
            &source,
            &normalized_folder,
            &normalized_folder,
            &mut tokens,
            false,
        ) {
            ghosts.append(&mut additional);
        }
    }

    ghosts.sort_by_cached_key(|ghost| ghost.name.to_lowercase());

    // フィンガープリント計算
    tokens.sort();
    let mut hasher = DefaultHasher::new();
    for token in &tokens {
        token.hash(&mut hasher);
    }
    let fingerprint = format!("{:016x}", hasher.finish());

    Ok((ghosts, fingerprint))
}
