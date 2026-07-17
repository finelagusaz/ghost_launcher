use std::fs;
use std::path::{Path, PathBuf};

use rayon::prelude::*;
use sha2::{Digest, Sha256};

use ghost_meta::{AlphaMode, ThumbnailKind};

use super::fingerprint::{
    build_entry_token, compute_fingerprint_hash, metadata_modified_string,
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
