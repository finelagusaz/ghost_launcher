use sha2::{Digest, Sha256};
use std::fs;
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

/// 追加フォルダが存在しない・ディレクトリでない場合の親エントリトークンを生成する。
/// state: "missing" または "not-directory"
pub(crate) fn push_absent_parent_token(
    tokens: &mut Vec<String>,
    parent_label: &str,
    normalized_parent: &str,
    state: &str,
) {
    tokens.push(format!(
        "parent|{}|{}|{}",
        parent_label, normalized_parent, state
    ));
}

/// ゴーストエントリ1件分のフィンガープリントトークンを生成する（pure function）。
/// 戻り値: (token_string, descript_state)
/// descript_state は "missing" / "present" / "unreadable" のいずれか。
pub(crate) fn build_entry_token(
    parent_label: &str,
    normalized_parent: &str,
    directory_name: &str,
    entry_meta: &fs::Metadata,
    descript_path: &Path,
) -> (String, String) {
    let dir_modified = metadata_modified_string(entry_meta);
    let (descript_state, descript_modified) = descript_metadata_for_token(descript_path);
    let token = format!(
        "entry|{}|{}|{}|{}|{}|{}",
        parent_label,
        normalized_parent,
        directory_name,
        dir_modified,
        descript_state,
        descript_modified
    );
    (token, descript_state)
}

/// 各親ディレクトリの mtime を収集し、"path:mtime_nanos" 形式の文字列を返す。
/// ソート済みで結合するため、フォルダ順序に依存しない。
pub(crate) fn collect_parent_mtimes(
    ssp_path: &str,
    additional_folders: &[String],
) -> String {
    let mut entries: Vec<String> = Vec::new();

    // SSP の ghost/ ディレクトリ
    let ghost_dir = std::path::PathBuf::from(ssp_path).join("ghost");
    let normalized = normalize_path(&ghost_dir);
    let mtime = fs::metadata(&ghost_dir)
        .as_ref()
        .map(metadata_modified_string)
        .unwrap_or_else(|_| "missing".to_string());
    entries.push(format!("{}:{}", normalized, mtime));

    // 追加フォルダ（正規化・重複排除・ソート済み）
    for (_, folder_path, normalized_folder) in unique_sorted_additional_folders(additional_folders) {
        let mtime = fs::metadata(&folder_path)
            .as_ref()
            .map(metadata_modified_string)
            .unwrap_or_else(|_| "missing".to_string());
        entries.push(format!("{}:{}", normalized_folder, mtime));
    }

    entries.sort();
    entries.join("\n")
}

/// Layer 1 高速チェック: 親ディレクトリの mtime が前回と一致するか判定する。
/// 一致すればゴーストフォルダの追加・削除がないことが保証される（NTFS の特性）。
/// ただし既存ゴースト内の descript.txt 編集は検出できない（Layer 2 が必要）。
pub(crate) fn check_parent_mtimes_match(
    conn: &rusqlite::Connection,
    request_key: &str,
    current_mtimes: &str,
) -> bool {
    let stored: Option<String> = conn
        .query_row(
            "SELECT parent_mtimes FROM ghost_fingerprints WHERE request_key = ?1",
            [request_key],
            |row| row.get(0),
        )
        .ok();

    match stored {
        Some(ref s) if !s.is_empty() => s == current_mtimes,
        _ => false,
    }
}

/// トークン列からフィンガープリントハッシュを計算する
pub(crate) fn compute_fingerprint_hash(tokens: &[String]) -> String {
    let mut sorted = tokens.to_vec();
    sorted.sort();
    let mut hasher = Sha256::new();
    for token in sorted.iter() {
        hasher.update(token.as_bytes());
        hasher.update(b"\n"); // トークン間の区切り（境界混同防止）
    }
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

#[cfg(test)]
pub(crate) fn build_fingerprint(
    ssp_path: &str,
    additional_folders: &[String],
) -> Result<String, String> {
    use super::scan::{unique_sorted_additional_folders, walk_parent};

    let mut tokens = vec!["fingerprint-version|1".to_string()];
    let ghost_dir = Path::new(ssp_path).join("ghost");

    walk_parent(&ghost_dir, "ssp", true, &mut tokens, None)?;
    for (_, folder_path, normalized_folder) in unique_sorted_additional_folders(additional_folders)
    {
        walk_parent(&folder_path, &normalized_folder, false, &mut tokens, None)?;
    }

    Ok(compute_fingerprint_hash(&tokens))
}
