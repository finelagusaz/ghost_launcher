use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

use super::path_utils::{normalize_path, unique_sorted_additional_folders};

/// fs::Metadata から更新時刻の nanos 文字列を取得するヘルパー
pub(crate) fn metadata_modified_string(meta: &fs::Metadata) -> String {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos().to_string())
        .unwrap_or_else(|| "unreadable".to_string())
}

/// descript.txt の metadata から (state, modified) のトークン用タプルを取得する
fn descript_metadata_for_token(descript_path: &Path) -> (String, String) {
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

/// 存在する親ディレクトリの親エントリトークンを生成する。
/// production walk（walk_parent）と delta walk（walk_parent_entries）が同一の親トークンを
/// 生成することを保証し、fingerprint のバイト一致（drift 防止）を構造的に担保する。
pub(crate) fn push_present_parent_token(
    tokens: &mut Vec<String>,
    parent_label: &str,
    normalized_parent: &str,
    modified: &str,
) {
    tokens.push(format!(
        "parent|{}|{}|{}",
        parent_label, normalized_parent, modified
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
pub(crate) fn collect_parent_mtimes(ssp_path: &str, additional_folders: &[String]) -> String {
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
    for (_, folder_path, normalized_folder) in unique_sorted_additional_folders(additional_folders)
    {
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
    finalize_hex(hasher)
}

/// SHA-256 ダイジェストを小文字・ゼロ埋めの hex 文字列にする（fingerprint 系 hex 化の単一権威）。
/// ghosts.db に永続化された値と一致させ続けるため、書式を変えてはならない
pub(crate) fn finalize_hex(hasher: Sha256) -> String {
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

#[cfg(test)]
fn build_fingerprint(ssp_path: &str, additional_folders: &[String]) -> Result<String, String> {
    use super::path_utils::unique_sorted_additional_folders;
    use super::scan::walk_parent;

    let mut tokens = vec!["fingerprint-version|1".to_string()];
    let ghost_dir = Path::new(ssp_path).join("ghost");

    walk_parent(&ghost_dir, "ssp", true, &mut tokens, None)?;
    for (_, folder_path, normalized_folder) in unique_sorted_additional_folders(additional_folders)
    {
        walk_parent(&folder_path, &normalized_folder, false, &mut tokens, None)?;
    }

    Ok(compute_fingerprint_hash(&tokens))
}

#[cfg(test)]
mod tests {
    use super::super::scan::scan_ghosts_with_fingerprint_internal;
    use super::{build_fingerprint, compute_fingerprint_hash};
    use crate::testutil::{TempDirGuard, create_ghost_dir};
    use std::fs;

    // 期待値は実装に依存させず sha256sum で独立に算出した値。ghosts.db に永続化された
    // fingerprint と一致し続けることを sha2 の版や hex 化の書き方に依らず固定する（#199）
    #[test]
    fn compute_fingerprint_hash_matches_reference_digest_for_empty_tokens() {
        // SHA-256("")
        assert_eq!(
            compute_fingerprint_hash(&[]),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn compute_fingerprint_hash_sorts_tokens_and_zero_pads_hex() {
        // SHA-256("a\nb\n")。ダイジェストに 0x0f を含むため 1 桁バイトのゼロ埋めも検証する
        let tokens = vec!["b".to_string(), "a".to_string()];
        assert_eq!(
            compute_fingerprint_hash(&tokens),
            "911169ddaaf146aff539f58c26c489af3b892dff0fe283c1c264c65ae5aa59a2"
        );
    }

    #[test]
    fn build_fingerprint_is_order_independent_for_additional_folders() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_fingerprint_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost)
            .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
        create_ghost_dir(&ssp_ghost, "base_ghost")?;

        let additional_a = workspace.path().join("additional_a");
        let additional_b = workspace.path().join("additional_b");
        fs::create_dir_all(&additional_a)
            .map_err(|error| format!("failed to create additional_a: {}", error))?;
        fs::create_dir_all(&additional_b)
            .map_err(|error| format!("failed to create additional_b: {}", error))?;
        create_ghost_dir(&additional_a, "extra_ghost_a")?;
        create_ghost_dir(&additional_b, "extra_ghost_b")?;

        let ordered = vec![
            additional_a.to_string_lossy().to_string(),
            additional_b.to_string_lossy().to_string(),
        ];
        let reversed = vec![
            additional_b.to_string_lossy().to_string(),
            additional_a.to_string_lossy().to_string(),
        ];

        let fingerprint_ordered = build_fingerprint(&ssp_root.to_string_lossy(), &ordered)?;
        let fingerprint_reversed = build_fingerprint(&ssp_root.to_string_lossy(), &reversed)?;

        assert_eq!(fingerprint_ordered, fingerprint_reversed);
        Ok(())
    }

    #[test]
    fn fingerprint_with_missing_additional_folder_matches_scan_fingerprint() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_missing_folder_fp_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost)
            .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
        create_ghost_dir(&ssp_ghost, "test_ghost")?;

        // 存在しない追加フォルダ（missing ケース）
        let nonexistent = workspace.path().join("nonexistent_folder");
        // 存在するがファイル（not-directory ケース）
        let not_a_dir = workspace.path().join("not_a_dir.txt");
        fs::write(&not_a_dir, "").map_err(|error| format!("failed to create file: {}", error))?;

        let additional_folders = vec![
            nonexistent.to_string_lossy().to_string(),
            not_a_dir.to_string_lossy().to_string(),
        ];
        let ssp_path = ssp_root.to_string_lossy().to_string();

        let standalone = build_fingerprint(&ssp_path, &additional_folders)?;
        let (_, integrated) =
            scan_ghosts_with_fingerprint_internal(&ssp_path, &additional_folders)?;

        assert_eq!(standalone, integrated);
        Ok(())
    }

    #[test]
    fn integrated_fingerprint_matches_standalone_build_fingerprint() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_fp_consistency_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost)
            .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
        create_ghost_dir(&ssp_ghost, "ghost_a")?;
        create_ghost_dir(&ssp_ghost, "ghost_b")?;

        let additional = workspace.path().join("additional");
        fs::create_dir_all(&additional)
            .map_err(|error| format!("failed to create additional: {}", error))?;
        create_ghost_dir(&additional, "extra_ghost")?;

        let additional_folders = vec![additional.to_string_lossy().to_string()];
        let ssp_path = ssp_root.to_string_lossy().to_string();

        let standalone = build_fingerprint(&ssp_path, &additional_folders)?;
        let (_, integrated) =
            scan_ghosts_with_fingerprint_internal(&ssp_path, &additional_folders)?;

        assert_eq!(standalone, integrated);
        Ok(())
    }
}
