use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::Path;

use super::path_utils::normalize_path;
use super::scan::unique_sorted_additional_folders;

/// fs::Metadata から更新時刻の nanos 文字列を取得するヘルパー
pub(crate) fn metadata_modified_string(meta: &fs::Metadata) -> String {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos().to_string())
        .unwrap_or_else(|| "unreadable".to_string())
}

/// descript.txt の metadata から (state, modified) のトークン用タプルを取得する
pub(crate) fn descript_metadata_for_token(descript_path: &Path) -> (String, String) {
    match fs::metadata(descript_path) {
        Err(_) => ("missing".to_string(), "-".to_string()),
        Ok(meta) => match meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
        {
            Some(nanos) => ("present".to_string(), nanos.to_string()),
            None => ("unreadable".to_string(), "-".to_string()),
        },
    }
}

/// トークン列からフィンガープリントハッシュを計算する
pub(crate) fn compute_fingerprint_hash(tokens: &mut Vec<String>) -> String {
    tokens.sort();
    let mut hasher = DefaultHasher::new();
    for token in tokens.iter() {
        token.hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

fn push_parent_fingerprint_tokens(
    tokens: &mut Vec<String>,
    parent_label: &str,
    parent_dir: &Path,
    required: bool,
) -> Result<(), String> {
    let normalized_parent = normalize_path(parent_dir);

    if !parent_dir.exists() {
        if required {
            return Err(format!(
                "ghost フォルダが見つかりません: {}",
                parent_dir.display()
            ));
        }
        tokens.push(format!("parent|{}|{}|missing", parent_label, normalized_parent));
        return Ok(());
    }

    if !parent_dir.is_dir() {
        if required {
            return Err(format!(
                "ghost フォルダがディレクトリではありません: {}",
                parent_dir.display()
            ));
        }
        tokens.push(format!(
            "parent|{}|{}|not-directory",
            parent_label, normalized_parent
        ));
        return Ok(());
    }

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
            return Ok(());
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(value) => value,
            Err(_) => continue,
        };

        // entry.metadata() は Windows では FindNextFile のキャッシュを利用（modified time 取得用）
        let entry_meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let directory_name = match path.file_name().and_then(|name| name.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };

        let dir_modified = metadata_modified_string(&entry_meta);

        let descript_path = path.join("ghost").join("master").join("descript.txt");
        let (descript_state, descript_modified) = descript_metadata_for_token(&descript_path);

        tokens.push(format!(
            "entry|{}|{}|{}|{}|{}|{}",
            parent_label,
            normalized_parent,
            directory_name,
            dir_modified,
            descript_state,
            descript_modified
        ));
    }

    Ok(())
}

pub(crate) fn build_fingerprint(
    ssp_path: &str,
    additional_folders: &[String],
) -> Result<String, String> {
    let mut tokens = vec!["fingerprint-version|1".to_string()];
    let ghost_dir = Path::new(ssp_path).join("ghost");

    push_parent_fingerprint_tokens(&mut tokens, "ssp", &ghost_dir, true)?;
    for (_, folder_path, normalized_folder) in unique_sorted_additional_folders(additional_folders) {
        push_parent_fingerprint_tokens(&mut tokens, &normalized_folder, &folder_path, false)?;
    }

    Ok(compute_fingerprint_hash(&mut tokens))
}
