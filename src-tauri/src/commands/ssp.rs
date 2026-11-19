use std::path::{Component, Path};
use std::process::Command;

use crate::commands::error::CommandError;

/// SSP へ渡すゴースト指定引数を構築する。
/// SSP 内ゴースト（source == "ssp"）はディレクトリ名のみ、外部ゴーストはフルパス。
fn build_ghost_arg(ghost_source: &str, ghost_directory_name: &str) -> String {
    if ghost_source == "ssp" {
        ghost_directory_name.to_string()
    } else {
        Path::new(ghost_source)
            .join(ghost_directory_name)
            .to_string_lossy()
            .into_owned()
    }
}

/// SSP フォルダのパスを検証する（ssp.exe の存在確認）
#[tauri::command]
pub fn validate_ssp_path(ssp_path: String) -> Result<(), CommandError> {
    ensure_local_ssp_path(&ssp_path)?;
    let ssp_exe = Path::new(&ssp_path).join("ssp.exe");
    if !ssp_exe.exists() {
        return Err(CommandError::SspExeNotFound {
            path: ssp_exe.display().to_string(),
        });
    }
    Ok(())
}

/// SSP.exe を指定したゴーストで起動する
#[tauri::command]
pub fn launch_ghost(
    ssp_path: String,
    ghost_directory_name: String,
    ghost_source: String,
) -> Result<(), CommandError> {
    ensure_local_ssp_path(&ssp_path)?;
    let ssp_exe = Path::new(&ssp_path).join("ssp.exe");

    if !ssp_exe.exists() {
        return Err(CommandError::SspExeNotFound {
            path: ssp_exe.display().to_string(),
        });
    }

    let ghost_arg = build_ghost_arg(&ghost_source, &ghost_directory_name);

    Command::new(&ssp_exe)
        .arg("/g")
        .arg(&ghost_arg)
        .current_dir(&ssp_path)
        .spawn()
        .map_err(|e| CommandError::SspLaunchFailed {
            detail: e.to_string(),
        })?;

    Ok(())
}

/// webview から受け取った SSP フォルダを、ローカルのドライブ文字で始まる絶対パスに限る。
///
/// 乗っ取られた webview が `\\attacker\share` を渡すと、リモート共有上の `ssp.exe` を
/// 起動できてしまう。UNC は `exists()` の時点で SMB 接続（NTLM 認証の送出）も起こすため、
/// ファイルシステムに触れる前にここで弾く。割り当て済みのネットワークドライブ（`Z:` 等）は
/// 利用者が自分で割り当てたものなので通す。判定はサムネイルのプロトコル（PR #244 の
/// `thumbnail_protocol::is_drive_path`）と同じ考え方で、両方が main に揃ったら共通化する。
fn ensure_local_ssp_path(ssp_path: &str) -> Result<(), CommandError> {
    let path = Path::new(ssp_path);
    let is_local = path.is_absolute()
        && !path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        && is_drive_path(path);
    if is_local {
        Ok(())
    } else {
        Err(CommandError::SspPathNotLocal {
            path: ssp_path.to_string(),
        })
    }
}

#[cfg(windows)]
fn is_drive_path(path: &Path) -> bool {
    use std::path::Prefix;
    match path.components().next() {
        Some(Component::Prefix(prefix)) => {
            matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
        }
        _ => false,
    }
}

#[cfg(not(windows))]
fn is_drive_path(_path: &Path) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::{
        CommandError, build_ghost_arg, ensure_local_ssp_path, launch_ghost, validate_ssp_path,
    };

    fn assert_rejected(path: &str) {
        assert_eq!(
            ensure_local_ssp_path(path),
            Err(CommandError::SspPathNotLocal {
                path: path.to_string()
            }),
            "拒否されるべきパスが通った: {path}"
        );
    }

    #[test]
    fn unc形式のsspフォルダを拒否する() {
        assert_rejected("\\\\attacker.invalid\\share");
        assert_rejected("//attacker.invalid/share");
        assert_rejected("\\\\?\\UNC\\attacker.invalid\\share");
        assert_rejected("\\\\.\\C:\\SSP");
    }

    #[test]
    fn 相対パスとドライブ相対のsspフォルダを拒否する() {
        assert_rejected("SSP");
        assert_rejected("..\\SSP");
        assert_rejected("\\SSP");
        assert_rejected("C:SSP");
        assert_rejected("");
    }

    #[test]
    fn 親ディレクトリ参照を含むsspフォルダを拒否する() {
        assert_rejected("C:\\SSP\\..\\Other");
        assert_rejected("\\\\?\\C:\\SSP\\..\\Other");
    }

    #[test]
    #[cfg(windows)]
    fn ドライブ文字で始まる絶対パスのsspフォルダは通す() {
        for path in ["C:\\SSP", "Z:\\Apps\\SSP", "c:/ssp", "\\\\?\\C:\\SSP"] {
            assert_eq!(ensure_local_ssp_path(path), Ok(()), "{path}");
        }
    }

    /// UNC への `exists()` 自体が SMB 接続を起こすため、存在確認より前に拒否する。
    /// 存在確認が先に走れば `SspExeNotFound` が返り、この試験は落ちる。
    #[test]
    fn validate_ssp_path_はunc形式を存在確認より前に拒否する() {
        let result = validate_ssp_path("\\\\attacker.invalid\\share".to_string());
        assert!(
            matches!(result, Err(CommandError::SspPathNotLocal { .. })),
            "{result:?}"
        );
    }

    #[test]
    fn launch_ghost_はunc形式を存在確認より前に拒否する() {
        let result = launch_ghost(
            "\\\\attacker.invalid\\share".to_string(),
            "my_ghost".to_string(),
            "ssp".to_string(),
        );
        assert!(
            matches!(result, Err(CommandError::SspPathNotLocal { .. })),
            "{result:?}"
        );
    }

    #[test]
    fn ssp内ゴーストはディレクトリ名のみを渡す() {
        assert_eq!(build_ghost_arg("ssp", "my_ghost"), "my_ghost");
    }

    #[test]
    fn 外部ゴーストはsourceと結合したフルパスを渡す() {
        assert_eq!(
            build_ghost_arg("C:\\Ghosts\\Extra", "my_ghost"),
            "C:\\Ghosts\\Extra\\my_ghost"
        );
    }

    #[test]
    fn validate_ssp_path_はssp_exe不在でエラーを返す() {
        let result = validate_ssp_path("C:\\__ghost_launcher_no_such_dir__".to_string());
        assert!(matches!(result, Err(CommandError::SspExeNotFound { .. })));
    }
}
