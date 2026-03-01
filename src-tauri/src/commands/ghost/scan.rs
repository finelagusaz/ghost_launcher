use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use ghost_meta::{AlphaMode, ThumbnailKind};

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
    let craftman = meta.craftman.unwrap_or_default();
    let directory_name = meta.directory_name;
    let path = meta.path.to_string_lossy().into_owned();
    let alpha_str = if thumbnail_use_self_alpha { "1" } else { "0" };
    let diff_fingerprint = {
        let mut hasher = Sha256::new();
        for fragment in [
            name.as_str(),
            craftman.as_str(),
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
        craftman,
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
        .map(|meta| ghost_from_meta(meta, "ssp".to_string()))
        .collect();

    // 追加フォルダをスキャン
    for (source, folder_path, _) in unique_sorted_additional_folders(additional_folders) {
        if !folder_path.exists() || !folder_path.is_dir() {
            continue;
        }
        if let Ok(metas) = ghost_meta::scan_ghosts(&folder_path) {
            ghosts.extend(metas.into_iter().map(|meta| ghost_from_meta(meta, source.clone())));
        }
    }

    ghosts.sort_by_cached_key(|ghost| ghost.name.to_lowercase());

    // フィンガープリント計算（fingerprint モジュールに委譲）
    let fingerprint = super::fingerprint::build_fingerprint(ssp_path, additional_folders)?;

    Ok((ghosts, fingerprint))
}
