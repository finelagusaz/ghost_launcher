use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::Path;

use super::path_utils::{modified_nanos, normalize_path};
use super::scan::unique_sorted_additional_folders;

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

    let parent_modified = modified_nanos(parent_dir)
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unreadable".to_string());
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
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let directory_name = match path.file_name().and_then(|name| name.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };

        let dir_modified = modified_nanos(&path)
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unreadable".to_string());

        let descript_path = path.join("ghost").join("master").join("descript.txt");
        let (descript_state, descript_modified) = if !descript_path.exists() {
            ("missing".to_string(), "-".to_string())
        } else {
            match modified_nanos(&descript_path) {
                Some(value) => ("present".to_string(), value.to_string()),
                None => ("unreadable".to_string(), "-".to_string()),
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

    tokens.sort();

    let mut hasher = DefaultHasher::new();
    for token in &tokens {
        token.hash(&mut hasher);
    }

    Ok(format!("{:016x}", hasher.finish()))
}
