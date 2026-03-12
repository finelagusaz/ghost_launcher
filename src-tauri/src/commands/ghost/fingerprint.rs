use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

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

/// ゴーストエントリ1件分のフィンガープリントトークンを生成して push する。
/// 戻り値: descript_state（"missing" / "present" / "unreadable"）
/// walk_parent が Ghost 構築判定に使用する。
pub(crate) fn push_entry_token(
    tokens: &mut Vec<String>,
    parent_label: &str,
    normalized_parent: &str,
    directory_name: &str,
    entry_meta: &fs::Metadata,
    descript_path: &Path,
) -> String {
    let dir_modified = metadata_modified_string(entry_meta);
    let (descript_state, descript_modified) = descript_metadata_for_token(descript_path);
    tokens.push(format!(
        "entry|{}|{}|{}|{}|{}|{}",
        parent_label,
        normalized_parent,
        directory_name,
        dir_modified,
        descript_state,
        descript_modified
    ));
    descript_state
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
