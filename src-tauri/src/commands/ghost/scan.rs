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

/// 親ディレクトリを走査し、フィンガープリントトークン生成（+ オプションで Ghost 収集）を行う。
/// required=true のとき、ディレクトリが存在しない・読めない場合はエラーを返す。
/// ghosts が Some のとき、descript.txt が存在するエントリを Ghost として収集する。
pub(crate) fn walk_parent(
    parent_dir: &Path,
    parent_label: &str,
    required: bool,
    tokens: &mut Vec<String>,
    mut ghosts: Option<(&str, &mut Vec<Ghost>)>,
) -> Result<(), String> {
    let normalized_parent = normalize_path(parent_dir);

    if !parent_dir.exists() {
        if required {
            return Err(format!(
                "ghost フォルダが見つかりません: {}",
                parent_dir.display()
            ));
        }
        push_absent_parent_token(tokens, parent_label, &normalized_parent, "missing");
        return Ok(());
    }
    if !parent_dir.is_dir() {
        if required {
            return Err(format!(
                "ghost フォルダがディレクトリではありません: {}",
                parent_dir.display()
            ));
        }
        push_absent_parent_token(tokens, parent_label, &normalized_parent, "not-directory");
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
        Ok(e) => e,
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
        if let Some((source, ref mut ghost_list)) = ghosts {
            if descript_state == "present" {
                if let Ok(meta) = ghost_meta::read_ghost(&path) {
                    ghost_list.push(ghost_from_meta(meta, source.to_string()));
                }
            }
        }
    }

    Ok(())
}

/// scan と fingerprint を 1 パスで実行する統合関数。
/// ゴーストメタデータ収集とフィンガープリントトークン生成を同じ read_dir ループで行う。
pub(crate) fn scan_ghosts_with_fingerprint_internal(
    ssp_path: &str,
    additional_folders: &[String],
) -> Result<(Vec<Ghost>, String), String> {
    let ghost_dir = Path::new(ssp_path).join("ghost");
    let mut tokens = vec!["fingerprint-version|1".to_string()];
    let mut ghosts: Vec<Ghost> = Vec::new();

    walk_parent(&ghost_dir, "ssp", true, &mut tokens, Some(("ssp", &mut ghosts)))?;

    for (source, folder_path, normalized_folder) in unique_sorted_additional_folders(additional_folders) {
        walk_parent(
            &folder_path,
            &normalized_folder,
            false,
            &mut tokens,
            Some((&source, &mut ghosts)),
        )?;
    }

    ghosts.sort_by_cached_key(|ghost| ghost.name.to_lowercase());

    Ok((ghosts, compute_fingerprint_hash(&tokens)))
}
