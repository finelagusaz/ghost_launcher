use crate::utils::descript;
use serde::Serialize;
use std::fs;
use std::path::Path;

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

/// 指定ディレクトリ内のゴーストサブディレクトリをスキャンする
fn scan_ghost_dir(parent_dir: &Path, source: &str) -> Vec<Ghost> {
    let mut ghosts = Vec::new();

    let entries = match fs::read_dir(parent_dir) {
        Ok(e) => e,
        Err(_) => return ghosts,
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

        // ghost/master/descript.txt を探す
        let descript_path = path.join("ghost").join("master").join("descript.txt");
        if !descript_path.exists() {
            continue;
        }

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

    ghosts
}

/// SSP フォルダ内の ghost/ ディレクトリ + 追加フォルダをスキャンし、ゴースト一覧を返す
#[tauri::command]
pub fn scan_ghosts(ssp_path: String, additional_folders: Vec<String>) -> Result<Vec<Ghost>, String> {
    let ghost_dir = Path::new(&ssp_path).join("ghost");

    if !ghost_dir.exists() {
        return Err(format!(
            "ghost フォルダが見つかりません: {}",
            ghost_dir.display()
        ));
    }

    // SSP の ghost/ ディレクトリをスキャン
    let mut ghosts = scan_ghost_dir(&ghost_dir, "ssp");

    // 追加フォルダをスキャン
    for folder in &additional_folders {
        let folder_path = Path::new(folder);
        if folder_path.exists() && folder_path.is_dir() {
            let mut additional = scan_ghost_dir(folder_path, folder);
            ghosts.append(&mut additional);
        }
    }

    // 名前でソート
    ghosts.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(ghosts)
}
