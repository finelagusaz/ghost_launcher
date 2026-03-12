use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use ghost_meta::{AlphaMode, ThumbnailKind};

use super::fingerprint::{
    compute_fingerprint_hash, metadata_modified_string, push_absent_parent_token, push_entry_token,
};
use super::path_utils::normalize_path;
use super::types::Ghost;

/// GhostMeta から Ghost 構造体へ変換するヘルパー
fn ghost_from_meta(meta: ghost_meta::GhostMeta, source: String) -> Ghost {
    let (thumbnail_path, thumbnail_use_self_alpha, thumbnail_kind) = meta.thumbnail.map_or(
        (String::new(), false, String::new()),
        |info| {
            let kind = match info.kind {
                ThumbnailKind::Surface => "surface".to_string(),
                ThumbnailKind::Thumbnail => "thumbnail".to_string(),
            };
            (
                info.path.to_string_lossy().into_owned(),
                info.alpha == AlphaMode::SelfAlpha,
                kind,
            )
        },
    );
    let name = meta.name;
    let sakura_name = meta.sakura_name.unwrap_or_default();
    let kero_name = meta.kero_name.unwrap_or_default();
    let craftman = meta.craftman.unwrap_or_default();
    let craftmanw = meta.craftmanw.unwrap_or_default();
    let directory_name = meta.directory_name;
    let path = meta.path.to_string_lossy().into_owned();
    let alpha_str = if thumbnail_use_self_alpha { "1" } else { "0" };
    let diff_fingerprint = {
        let mut hasher = Sha256::new();
        for fragment in [
            name.as_str(),
            sakura_name.as_str(),
            kero_name.as_str(),
            craftman.as_str(),
            craftmanw.as_str(),
            path.as_str(),
            thumbnail_path.as_str(),
            alpha_str,
            thumbnail_kind.as_str(),
        ] {
            hasher.update(fragment.as_bytes());
            hasher.update([0x1f]);
        }
        format!("{:x}", hasher.finalize())
    };

    Ghost {
        diff_fingerprint,
        name,
        sakura_name,
        kero_name,
        craftman,
        craftmanw,
        directory_name,
        path,
        source,
        thumbnail_path,
        thumbnail_use_self_alpha,
        thumbnail_kind,
    }
}

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

/// 親ディレクトリを 1 パスでスキャンし、Ghost 収集とフィンガープリントトークン生成を同時に行う。
/// required=true のとき、ディレクトリが存在しない・読めない場合はトークンを push せずそのまま返す
///（呼び出し元が先に存在チェックを行うことを想定）。
fn scan_parent_one_pass(
    parent_dir: &Path,
    parent_label: &str,
    tokens: &mut Vec<String>,
    ghosts: &mut Vec<Ghost>,
    source: &str,
) {
    let normalized_parent = normalize_path(parent_dir);

    if !parent_dir.exists() {
        push_absent_parent_token(tokens, parent_label, &normalized_parent, "missing");
        return;
    }
    if !parent_dir.is_dir() {
        push_absent_parent_token(tokens, parent_label, &normalized_parent, "not-directory");
        return;
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
        Ok(e) => e,
        Err(_) => {
            tokens.push(format!(
                "entries|{}|{}|unreadable",
                parent_label, normalized_parent
            ));
            return;
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
        // fs::metadata は Windows NTFS の遅延タイムスタンプ問題を回避するため entry.metadata() を使わない
        let entry_meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let directory_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let descript_path = path.join("ghost").join("master").join("descript.txt");
        let descript_state = push_entry_token(
            tokens,
            parent_label,
            &normalized_parent,
            &directory_name,
            &entry_meta,
            &descript_path,
        );

        // descript.txt が存在するエントリのみ Ghost として収集する
        if descript_state == "present" {
            if let Ok(meta) = ghost_meta::read_ghost(&path) {
                ghosts.push(ghost_from_meta(meta, source.to_string()));
            }
        }
    }
}

/// scan と fingerprint を 1 パスで実行する統合関数。
/// ゴーストメタデータ収集とフィンガープリントトークン生成を同じ read_dir ループで行う。
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
    let mut ghosts: Vec<Ghost> = Vec::new();

    scan_parent_one_pass(&ghost_dir, "ssp", &mut tokens, &mut ghosts, "ssp");

    for (source, folder_path, normalized_folder) in unique_sorted_additional_folders(additional_folders) {
        scan_parent_one_pass(
            &folder_path,
            &normalized_folder,
            &mut tokens,
            &mut ghosts,
            &source,
        );
    }

    ghosts.sort_by_cached_key(|ghost| ghost.name.to_lowercase());

    Ok((ghosts, compute_fingerprint_hash(&tokens)))
}
