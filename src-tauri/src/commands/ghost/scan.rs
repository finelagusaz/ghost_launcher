use std::fs;
use std::path::{Path, PathBuf};

use rayon::prelude::*;
use sha2::{Digest, Sha256};

use ghost_meta::{AlphaMode, ThumbnailKind};

use super::fingerprint::{
    build_entry_token, compute_fingerprint_hash, finalize_hex, metadata_modified_string,
    push_absent_parent_token, push_present_parent_token,
};
use super::path_utils::{normalize_path, unique_sorted_additional_folders};
use super::store::ghost_identity_key;
use super::types::Ghost;

/// scan_key（走査差分の生の物理キー）のセパレータ。制御文字は Windows のファイル名に
/// 使えないため、normalized_parent と生 directory_name の境界が名前と衝突しない。
const SCAN_KEY_SEPARATOR: char = '\x1f';

/// read_dir エントリが「走査対象のディレクトリ」かを判定する（production walk と delta walk の共有）。
/// 通常のディレクトリ／ファイルは read_dir がキャッシュした find-data の file_type() で判定し
/// （syscall ゼロ）、逐次 is_dir(stat) を消す。symlink/junction（reparse point）は file_type() が
/// 実体を辿らず dir を false と返すため、reparse point または file_type 取得失敗時のみ fs::metadata
/// で実体解決する（従来 is_dir() が junction 越しのゴーストを拾っていた挙動を保存する）。
fn is_scannable_dir(entry: &fs::DirEntry) -> bool {
    match entry.file_type() {
        Ok(t) if t.is_dir() => true,
        Ok(t) if t.is_file() => false,
        _ => fs::metadata(entry.path())
            .map(|m| m.is_dir())
            .unwrap_or(false),
    }
}

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
        finalize_hex(hasher)
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

/// 親ディレクトリを走査し、フィンガープリントトークン生成（+ オプションで Ghost 収集）を行う。
/// required=true のとき、ディレクトリが存在しない・読めない場合はエラーを返す。
/// ghosts が Some のとき、descript.txt が存在するエントリを Ghost として収集する。
///
/// 本番の Layer 2 は delta 経路（walk_parent_entries → parse は変更子のみ）に移行したため、
/// この全 parse walk はテスト（scan_entries_with_fingerprint との fingerprint parity 参照）と
/// bench（full_scan 計測）専用。
#[cfg(any(test, feature = "bench"))]
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
    push_present_parent_token(tokens, parent_label, &normalized_parent, &parent_modified);

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

    // エントリを Vec に収集（par_iter の前提）。子の絞り込みは逐次で行い、OS ディレクトリ
    // ハンドルを早期に解放する。ディレクトリ判定は is_scannable_dir（file_type + reparse
    // フォールバック）に集約し、production walk と delta walk で同一の絞り込みを保証する。
    let paths: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .filter(is_scannable_dir)
        .map(|e| e.path())
        .collect();

    // 並列処理: 各エントリのトークン生成 + Ghost 読み取り
    struct EntryResult {
        token: String,
        ghost: Option<Ghost>,
    }

    let source_str = ghosts.as_ref().map(|(s, _)| s.to_string());
    let results: Vec<EntryResult> = paths
        .par_iter()
        .filter_map(|path| {
            // fs::metadata は Windows NTFS の遅延タイムスタンプ問題を回避するため entry.metadata() を使わない
            let entry_meta = fs::metadata(path).ok()?;
            let directory_name = path.file_name()?.to_str()?.to_string();
            let descript_path = path.join("ghost").join("master").join("descript.txt");

            let (token, descript_state) = build_entry_token(
                parent_label,
                &normalized_parent,
                &directory_name,
                &entry_meta,
                &descript_path,
            );

            let ghost = if source_str.is_some() && descript_state == "present" {
                ghost_meta::read_ghost(path)
                    .ok()
                    .map(|meta| ghost_from_meta(meta, source_str.as_ref().unwrap().clone()))
            } else {
                None
            };

            Some(EntryResult { token, ghost })
        })
        .collect();

    // 逐次: 結果をマージ
    for result in results {
        tokens.push(result.token);
        if let Some(ghost) = result.ghost
            && let Some((_, ref mut ghost_list)) = ghosts
        {
            ghost_list.push(ghost);
        }
    }

    Ok(())
}

/// scan と fingerprint を 1 パスで実行する統合関数（全 parse）。
/// ゴーストメタデータ収集とフィンガープリントトークン生成を同じ read_dir ループで行う。
/// 本番は delta 経路（scan_entries_with_fingerprint）へ移行したため、テスト（parity 参照）と
/// bench（full_scan 計測）専用。
#[cfg(any(test, feature = "bench"))]
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

    Ok((ghosts, compute_fingerprint_hash(&tokens)))
}

/// 走査差分（delta）の 1 エントリ（子ディレクトリ 1 件）。parse 前の状態を持つ内部表現で、
/// IPC 境界（Ghost / ScanStoreResult）には混入させない。
pub(crate) struct ScanEntry {
    /// 生の物理キー（normalized_parent + SEP + 生 directory_name）。差分の主キー。
    /// NFKC 畳み込みを避け、物理的に別のディレクトリを別エントリとして保つ（サイレント消失防止）。
    pub(crate) scan_key: String,
    /// fingerprint トークン（変更検知シグナル。dir mtime + descript 状態/mtime を含む）。
    pub(crate) token: String,
    /// 畳み込み論理キー（NFKC(source)+SEP+NFKC(dir)）。ghosts 操作・一意性ガードに使う。
    pub(crate) identity_key: String,
    /// エントリの絶対パス（変更子の parse に使う）。
    pub(crate) path: PathBuf,
    /// ゴースト source（"ssp" または追加フォルダの生パス）。parse 時に Ghost へ載せる。
    pub(crate) source: String,
    /// descript.txt が present か（present のみ parse 対象）。
    pub(crate) is_present: bool,
}

/// delta 用 walk: 親を walk して子ごとの ScanEntry を collect しつつ fingerprint トークンを push する。
/// walk_parent と同一のフィルタ（is_scannable_dir）・同一の親/エントリトークンを使い、parse は
/// 行わない（is_present だけ記録し、変更子だけ後段で parse する）。source は identity/scan_key の算出に使う。
fn walk_parent_entries(
    parent_dir: &Path,
    parent_label: &str,
    source: &str,
    required: bool,
    tokens: &mut Vec<String>,
    entries: &mut Vec<ScanEntry>,
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
    push_present_parent_token(tokens, parent_label, &normalized_parent, &parent_modified);

    let read = match fs::read_dir(parent_dir) {
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

    let paths: Vec<PathBuf> = read
        .filter_map(|e| e.ok())
        .filter(is_scannable_dir)
        .map(|e| e.path())
        .collect();

    // 並列: 各エントリの ScanEntry を構築（parse なし）。token は build_entry_token（walk_parent と共有）。
    let collected: Vec<ScanEntry> = paths
        .par_iter()
        .filter_map(|path| {
            let entry_meta = fs::metadata(path).ok()?;
            let directory_name = path.file_name()?.to_str()?.to_string();
            let descript_path = path.join("ghost").join("master").join("descript.txt");
            let (token, descript_state) = build_entry_token(
                parent_label,
                &normalized_parent,
                &directory_name,
                &entry_meta,
                &descript_path,
            );
            let scan_key = format!(
                "{}{}{}",
                normalized_parent, SCAN_KEY_SEPARATOR, directory_name
            );
            let identity_key = ghost_identity_key(source, &directory_name);
            Some(ScanEntry {
                scan_key,
                token,
                identity_key,
                path: path.clone(),
                source: source.to_string(),
                is_present: descript_state == "present",
            })
        })
        .collect();

    // 逐次: トークンをマージし entries を積む（token 順は fingerprint がソートするため不問）。
    for entry in collected {
        tokens.push(entry.token.clone());
        entries.push(entry);
    }

    Ok(())
}

/// delta の共有 walk: 全親を walk して ScanEntry 群 + fingerprint を返す（parse なし）。
/// fingerprint は scan_ghosts_with_fingerprint_internal と同一ツリーでバイト一致する
/// （parity をテストで固定）。walk_parent との drift は共有ヘルパー（is_scannable_dir・
/// build_entry_token・push_present/absent_parent_token）で構造的に抑える。
pub(crate) fn scan_entries_with_fingerprint(
    ssp_path: &str,
    additional_folders: &[String],
) -> Result<(Vec<ScanEntry>, String), String> {
    let ghost_dir = Path::new(ssp_path).join("ghost");
    let mut tokens = vec!["fingerprint-version|1".to_string()];
    let mut entries: Vec<ScanEntry> = Vec::new();

    walk_parent_entries(&ghost_dir, "ssp", "ssp", true, &mut tokens, &mut entries)?;
    for (source, folder_path, normalized_folder) in
        unique_sorted_additional_folders(additional_folders)
    {
        walk_parent_entries(
            &folder_path,
            &normalized_folder,
            &source,
            false,
            &mut tokens,
            &mut entries,
        )?;
    }

    Ok((entries, compute_fingerprint_hash(&tokens)))
}

/// present な ScanEntry を parse して Ghost を得る（parse 失敗＝内容破損/欠落は None）。
/// delta が変更子だけこれを呼び、None なら当該 identity を ghosts から DELETE する。
pub(crate) fn parse_entry(entry: &ScanEntry) -> Option<Ghost> {
    ghost_meta::read_ghost(&entry.path)
        .ok()
        .map(|meta| ghost_from_meta(meta, entry.source.clone()))
}

/// present な ScanEntry 上で ghost_identity_key の一意性を検証する（in-memory・DB read ゼロ）。
/// 別の scan_key（生の物理ディレクトリ）が同一 identity（NFKC 畳み込み）へ落ちる場合、loud に Err。
///
/// delta は不変子をスキップするため、全ゴーストを毎回突き合わせて DB 側 UNIQUE index に衝突を
/// loud に弾かせる従来経路が働かなくなる（不変な既存ゴーストに新規が畳み込むケースは共処理されない）。
/// walk が返す全 present エントリ（不変子も含む）上でここが単一権威として衝突を弾き、
/// 「サイレントなゴースト消失＋path 振動」への退行を防ぐ（設計書 §4.2）。
pub(crate) fn check_identity_uniqueness(entries: &[ScanEntry]) -> Result<(), String> {
    use std::collections::HashMap;
    let mut seen: HashMap<&str, &str> = HashMap::new();
    for entry in entries.iter().filter(|e| e.is_present) {
        if let Some(prev_scan_key) = seen.insert(&entry.identity_key, &entry.scan_key) {
            // 同一 scan_key の再出現（同一物理ディレクトリ）は衝突でない。別物理ディレクトリのみ弾く。
            if prev_scan_key != entry.scan_key {
                return Err(format!(
                    "ゴースト identity が衝突しています（NFKC 畳み込みで別ディレクトリが同一キーに）: {} / {}",
                    prev_scan_key, entry.scan_key
                ));
            }
        }
    }
    Ok(())
}

/// walk 単独コスト（parse 抜き）を計測するベンチ専用経路。共有 walk の fingerprint を返す。
/// 本番からは呼ばれない。
#[cfg(feature = "bench")]
pub(crate) fn fingerprint_only_internal(
    ssp_path: &str,
    additional_folders: &[String],
) -> Result<String, String> {
    Ok(scan_entries_with_fingerprint(ssp_path, additional_folders)?.1)
}

#[cfg(test)]
mod tests {
    use super::{ghost_from_meta, scan_ghosts_with_fingerprint_internal};
    use crate::testutil::{create_ghost_dir_with_descript, TempDirGuard};
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn diff_fingerprint_matches_reference_digest() {
        // 期待値は実装に依存させず sha256sum で独立に算出した
        // SHA-256("n\x1fs\x1f\x1f\x1f\x1fp\x1f\x1f0\x1f\x1f")。各フラグメント + 0x1f の連結で、
        // ダイジェストに 0x0a を含むため 1 桁バイトのゼロ埋めも検証する（#199）
        let meta = ghost_meta::GhostMeta {
            name: "n".to_string(),
            sakura_name: Some("s".to_string()),
            kero_name: None,
            craftman: None,
            craftmanw: None,
            directory_name: "d".to_string(),
            path: PathBuf::from("p"),
            thumbnail: None,
        };
        assert_eq!(
            ghost_from_meta(meta, "ssp".to_string()).diff_fingerprint,
            "bf0a1cd9f7ca3cfc59fa591404e421ac63d9bcca8b7fa5ec6f7330bc8993c3c1"
        );
    }

    #[test]
    fn scan_ghosts_internal_collects_sources() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_scan_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost)
            .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
        create_ghost_dir_with_descript(&ssp_ghost, "ssp_dir", "name,zulu\ncharset,UTF-8\n")?;

        let additional_a = workspace.path().join("additional_a");
        let additional_b = workspace.path().join("additional_b");
        fs::create_dir_all(&additional_a)
            .map_err(|error| format!("failed to create additional_a: {}", error))?;
        fs::create_dir_all(&additional_b)
            .map_err(|error| format!("failed to create additional_b: {}", error))?;
        create_ghost_dir_with_descript(&additional_a, "extra_a", "name,Alpha\ncharset,UTF-8\n")?;
        create_ghost_dir_with_descript(&additional_b, "extra_b", "name,bravo\ncharset,UTF-8\n")?;

        let additional_paths = vec![
            additional_b.to_string_lossy().to_string(),
            additional_a.to_string_lossy().to_string(),
        ];
        let (ghosts, _) =
            scan_ghosts_with_fingerprint_internal(&ssp_root.to_string_lossy(), &additional_paths)?;

        assert_eq!(ghosts.len(), 3);
        let mut names: Vec<&str> = ghosts.iter().map(|g| g.name.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["Alpha", "bravo", "zulu"]);

        let ssp_ghost_item = ghosts
            .iter()
            .find(|ghost| ghost.directory_name == "ssp_dir")
            .ok_or_else(|| "ssp ghost not found".to_string())?;
        assert_eq!(ssp_ghost_item.source, "ssp");

        let extra_a = ghosts
            .iter()
            .find(|ghost| ghost.directory_name == "extra_a")
            .ok_or_else(|| "extra_a ghost not found".to_string())?;
        assert_eq!(extra_a.source, additional_a.to_string_lossy());

        let extra_b = ghosts
            .iter()
            .find(|ghost| ghost.directory_name == "extra_b")
            .ok_or_else(|| "extra_b ghost not found".to_string())?;
        assert_eq!(extra_b.source, additional_b.to_string_lossy());

        Ok(())
    }

    #[test]
    fn scan_ghosts_internal_extracts_craftman_field() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_craftman_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost)
            .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
        create_ghost_dir_with_descript(
            &ssp_ghost,
            "with_craftman",
            "name,テストゴースト\ncraftman,プログラム\ncharset,UTF-8\n",
        )?;
        create_ghost_dir_with_descript(
            &ssp_ghost,
            "without_craftman",
            "name,作者なし\ncharset,UTF-8\n",
        )?;

        let (ghosts, _) = scan_ghosts_with_fingerprint_internal(&ssp_root.to_string_lossy(), &[])?;

        let with_craftman = ghosts
            .iter()
            .find(|ghost| ghost.directory_name == "with_craftman")
            .ok_or_else(|| "with_craftman ghost not found".to_string())?;
        assert_eq!(with_craftman.craftman, "プログラム");

        let without_craftman = ghosts
            .iter()
            .find(|ghost| ghost.directory_name == "without_craftman")
            .ok_or_else(|| "without_craftman ghost not found".to_string())?;
        assert_eq!(without_craftman.craftman, "");

        Ok(())
    }

    #[test]
    fn scan_ghosts_internal_falls_back_to_directory_name_without_name_field() -> Result<(), String>
    {
        let workspace = TempDirGuard::new("ghost_launcher_scan_fallback_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost)
            .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
        create_ghost_dir_with_descript(
            &ssp_ghost,
            "fallback_dir",
            "charset,UTF-8\n// no name field\n",
        )?;

        let (ghosts, _) = scan_ghosts_with_fingerprint_internal(&ssp_root.to_string_lossy(), &[])?;
        let fallback = ghosts
            .iter()
            .find(|ghost| ghost.directory_name == "fallback_dir")
            .ok_or_else(|| "fallback ghost not found".to_string())?;
        assert_eq!(fallback.name, "fallback_dir");
        assert_eq!(fallback.source, "ssp");
        Ok(())
    }

    #[test]
    fn scan_ghosts_internal_returns_error_when_ssp_ghost_dir_is_missing() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_missing_ghost_dir_test");
        let ssp_root = workspace.path().join("ssp_without_ghost");
        fs::create_dir_all(&ssp_root)
            .map_err(|error| format!("failed to create ssp root dir: {}", error))?;

        let result = scan_ghosts_with_fingerprint_internal(&ssp_root.to_string_lossy(), &[]);
        assert!(result.is_err());
        let error = result.err().ok_or_else(|| "expected error".to_string())?;
        assert!(error.contains("ghost フォルダが見つかりません"));
        Ok(())
    }

    /// 回帰: 子ディレクトリが junction（reparse point）でも、その先が実体ディレクトリなら
    /// ゴーストとして収集されること。`Path::is_dir()` は junction を辿るため現状も拾える。
    /// walk_parent の子絞り込みを `file_type()`（reparse point を false と返す）へ置換する際、
    /// symlink/junction を取りこぼさないフォールバックが要ることを縛る。
    /// junction は特権不要のため CI(windows-latest) でも実行できる（symlink は Developer Mode 必須）。
    #[cfg(windows)]
    #[test]
    fn scan_ghosts_internal_collects_junction_linked_ghost() -> Result<(), String> {
        use std::process::Command;

        let workspace = TempDirGuard::new("ghost_launcher_junction_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost)
            .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
        // 通常の実体ゴースト（回帰の基準・junction が通常収集を壊さないこと）
        create_ghost_dir_with_descript(&ssp_ghost, "normal_ghost", "name,Normal\ncharset,UTF-8\n")?;

        // junction の実体をツリー外に作る（ssp/ghost の直下ではない）
        let external = workspace.path().join("external");
        create_ghost_dir_with_descript(&external, "real_target", "name,Linked\ncharset,UTF-8\n")?;
        let target = external.join("real_target");
        let link = ssp_ghost.join("linked_ghost");

        // mklink /J は特権不要の directory junction を作る（cmd の内部コマンド）
        let status = Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&link)
            .arg(&target)
            .status()
            .map_err(|error| format!("mklink 起動に失敗: {}", error))?;
        assert!(status.success(), "mklink /J が失敗した: {:?}", status);

        let (ghosts, _) = scan_ghosts_with_fingerprint_internal(&ssp_root.to_string_lossy(), &[])?;

        assert!(
            ghosts.iter().any(|g| g.name == "Normal"),
            "通常ゴーストが収集されていない"
        );
        assert!(
            ghosts.iter().any(|g| g.name == "Linked"),
            "junction 越しのゴーストが取りこぼされた"
        );
        Ok(())
    }

    /// delta walk（scan_entries_with_fingerprint）の fingerprint が production walk
    /// （scan_ghosts_with_fingerprint_internal）と同一ツリーでバイト一致すること。
    /// 2 実装の drift ガード（Layer2 等値判定・getCachedFingerprint 往復契約の前提）。
    /// present／no-descript／追加フォルダ／存在しない追加フォルダの全トークン種を含める。
    #[test]
    fn scan_entries_fingerprint_matches_full_scan() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_delta_parity_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost).map_err(|e| format!("ssp ghost dir: {e}"))?;
        create_ghost_dir_with_descript(&ssp_ghost, "alpha", "name,Alpha\ncharset,UTF-8\n")?;
        create_ghost_dir_with_descript(&ssp_ghost, "bravo", "name,Bravo\ncharset,UTF-8\n")?;
        // descript を持たない子（token は出るが is_present=false・ghost にはならない）
        fs::create_dir_all(ssp_ghost.join("no_descript"))
            .map_err(|e| format!("no_descript dir: {e}"))?;

        let additional = workspace.path().join("additional");
        fs::create_dir_all(&additional).map_err(|e| format!("additional dir: {e}"))?;
        create_ghost_dir_with_descript(&additional, "charlie", "name,Charlie\ncharset,UTF-8\n")?;
        // 存在しない追加フォルダ（absent-parent トークン）
        let missing = workspace.path().join("missing_folder");

        let additional_folders = vec![
            additional.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
        ];
        let ssp_path = ssp_root.to_string_lossy().to_string();

        let (ghosts, full_fp) =
            scan_ghosts_with_fingerprint_internal(&ssp_path, &additional_folders)?;
        let (entries, delta_fp) =
            super::scan_entries_with_fingerprint(&ssp_path, &additional_folders)?;

        // fingerprint がバイト一致（2 walk 実装の drift ガード）
        assert_eq!(full_fp, delta_fp, "delta walk の fingerprint が production walk と不一致");

        // present エントリ数 = ghost 数（no_descript は present=false のため除外）
        let present = entries.iter().filter(|e| e.is_present).count();
        assert_eq!(present, ghosts.len());
        assert_eq!(present, 3, "alpha/bravo/charlie の 3 present を期待");
        assert!(
            entries
                .iter()
                .any(|e| e.scan_key.ends_with("no_descript") && !e.is_present),
            "no_descript は entries に含まれ is_present=false であるべき"
        );
        Ok(())
    }

    /// walk 時に scan_entries へ保存する identity_key が、parse 済み Ghost から算出する
    /// identity と一致すること（削除子の ghosts 操作・一意性ガードの狙い先が正しいことを固定）。
    #[test]
    fn scan_entry_identity_key_matches_parsed_ghost() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_delta_identity_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost).map_err(|e| format!("ssp ghost dir: {e}"))?;
        create_ghost_dir_with_descript(&ssp_ghost, "alpha", "name,Alpha\ncharset,UTF-8\n")?;

        let (entries, _) =
            super::scan_entries_with_fingerprint(&ssp_root.to_string_lossy(), &[])?;
        let entry = entries
            .iter()
            .find(|e| e.is_present)
            .ok_or_else(|| "present entry not found".to_string())?;
        let ghost = super::parse_entry(entry).ok_or_else(|| "parse failed".to_string())?;

        assert_eq!(
            entry.identity_key,
            super::ghost_identity_key(&ghost.source, &ghost.directory_name)
        );
        Ok(())
    }

    /// 一意性ガード: NFKC 畳み込みで別ディレクトリが同一 identity へ落ちる衝突を loud に弾く。
    /// walk は不変子も含む全 present エントリを返すため、「新規が不変既存に畳み込む」ケースも
    /// このガードで捕捉できる（delta の parse-skip で失われる DB 側 loud 性の単一代替）。
    #[test]
    fn check_identity_uniqueness_が_nfkc_衝突を_loud_に弾く() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_uniqueness_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost).map_err(|e| format!("ssp ghost dir: {e}"))?;
        // "Ａ"（全角 U+FF21）と "a"（ASCII）は NFKC + lower で同一 identity "ssp\x1fa" に畳み込まれる。
        // 生の scan_key（生 directory_name）は別物ゆえ、物理的に別ディレクトリが同一キーへ落ちる衝突。
        create_ghost_dir_with_descript(&ssp_ghost, "Ａ", "name,Fullwidth\ncharset,UTF-8\n")?;
        create_ghost_dir_with_descript(&ssp_ghost, "a", "name,Ascii\ncharset,UTF-8\n")?;

        let (entries, _) =
            super::scan_entries_with_fingerprint(&ssp_root.to_string_lossy(), &[])?;
        assert!(
            super::check_identity_uniqueness(&entries).is_err(),
            "NFKC 衝突が loud に弾かれていない（サイレント消失＋path 振動への退行）"
        );
        Ok(())
    }

    #[test]
    fn check_identity_uniqueness_が衝突なしで通る() -> Result<(), String> {
        let workspace = TempDirGuard::new("ghost_launcher_uniqueness_ok_test");
        let ssp_root = workspace.path().join("ssp");
        let ssp_ghost = ssp_root.join("ghost");
        fs::create_dir_all(&ssp_ghost).map_err(|e| format!("ssp ghost dir: {e}"))?;
        create_ghost_dir_with_descript(&ssp_ghost, "alpha", "name,Alpha\ncharset,UTF-8\n")?;
        create_ghost_dir_with_descript(&ssp_ghost, "bravo", "name,Bravo\ncharset,UTF-8\n")?;

        let (entries, _) =
            super::scan_entries_with_fingerprint(&ssp_root.to_string_lossy(), &[])?;
        assert!(super::check_identity_uniqueness(&entries).is_ok());
        Ok(())
    }
}
