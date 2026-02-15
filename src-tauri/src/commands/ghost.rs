use crate::utils::descript;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Serialize)]
pub struct Ghost {
    /// descript.txt の name フィールド（表示名）
    pub name: String,
    /// ゴーストのディレクトリ名（SSP起動時に使用）
    pub directory_name: String,
    /// ゴーストのフルパス
    pub path: String,
    /// ゴーストの出自（"ssp" or 追加フォルダのパス）
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanGhostsResponse {
    pub ghosts: Vec<Ghost>,
    pub fingerprint: String,
}

fn normalize_path(path: &Path) -> String {
    let normalized = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    normalized
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase()
}

fn modified_nanos(path: &Path) -> Option<u128> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let duration = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(duration.as_nanos())
}

fn unique_sorted_additional_folders(additional_folders: &[String]) -> Vec<(String, PathBuf, String)> {
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

/// 指定ディレクトリ内のゴーストサブディレクトリをスキャンする
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

        // ghost/master/descript.txt を読む
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

fn scan_ghosts_internal(ssp_path: &str, additional_folders: &[String]) -> Result<Vec<Ghost>, String> {
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

    // SSP の ghost/ ディレクトリをスキャン
    let mut ghosts = scan_ghost_dir(&ghost_dir, "ssp")?;

    // 追加フォルダをスキャン（重複パスは 1 回に統合）
    for (source, folder_path, _) in unique_sorted_additional_folders(additional_folders) {
        if folder_path.is_dir() {
            if let Ok(mut additional) = scan_ghost_dir(&folder_path, &source) {
                ghosts.append(&mut additional);
            }
        }
    }

    ghosts.sort_by_cached_key(|g| g.name.to_lowercase());
    Ok(ghosts)
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

    let parent_modified = modified_nanos(parent_dir)
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unreadable".to_string());
    tokens.push(format!(
        "parent|{}|{}|{}",
        parent_label, normalized_parent, parent_modified
    ));

    let entries = match fs::read_dir(parent_dir) {
        Ok(e) => e,
        Err(e) => {
            if required {
                return Err(format!(
                    "ディレクトリを読み取れませんでした ({}): {}",
                    parent_dir.display(),
                    e
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

fn build_fingerprint(ssp_path: &str, additional_folders: &[String]) -> Result<String, String> {
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

/// SSP フォルダ内の ghost/ ディレクトリ + 追加フォルダをスキャンし、ゴースト一覧を返す
#[tauri::command]
pub fn scan_ghosts(ssp_path: String, additional_folders: Vec<String>) -> Result<Vec<Ghost>, String> {
    scan_ghosts_internal(&ssp_path, &additional_folders)
}

/// ゴースト一覧のスキャン結果と、フォルダ状態指紋をまとめて返す
#[tauri::command]
pub fn scan_ghosts_with_meta(
    ssp_path: String,
    additional_folders: Vec<String>,
) -> Result<ScanGhostsResponse, String> {
    let ghosts = scan_ghosts_internal(&ssp_path, &additional_folders)?;
    let fingerprint = build_fingerprint(&ssp_path, &additional_folders)?;
    Ok(ScanGhostsResponse { ghosts, fingerprint })
}

/// ゴーストフォルダ群の状態指紋だけを返す
#[tauri::command]
pub fn get_ghosts_fingerprint(
    ssp_path: String,
    additional_folders: Vec<String>,
) -> Result<String, String> {
    build_fingerprint(&ssp_path, &additional_folders)
}
