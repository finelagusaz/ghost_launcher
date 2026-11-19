//! webview から受け取ったパスを、ファイルシステムに触れる前に字句で絞る。
//!
//! UNC パスは、存在確認（`exists()`・`canonicalize` 等）をしただけで任意のサーバへの SMB 接続
//! （NTLM 認証の送出）を起こし、実行するファイルならリモート上の exe を起動させる。このため判定は
//! 字句だけで行い、正規化もしない（正規化はファイルシステムに触れる）。正規化しない代わりに `..` を
//! 拒否して、判定した形の外へ出させない。

use std::path::{Component, Path};

/// ローカルのドライブ文字で始まる絶対パスか。
/// - 絶対パスである（ドライブ相対の `C:ssp` は通さない）
/// - `..` を含まない
/// - Windows ではドライブ文字で始まる（`C:\…`・`\\?\C:\…`）。UNC（`\\server\share`・`\\?\UNC\…`）と
///   デバイスパス（`\\.\…`）は通さない。割り当て済みのネットワークドライブ（`Z:` 等）は利用者が
///   自分で割り当てたものなので通す
pub(crate) fn is_local_drive_path(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        && starts_with_drive(path)
}

#[cfg(windows)]
fn starts_with_drive(path: &Path) -> bool {
    use std::path::Prefix;
    match path.components().next() {
        Some(Component::Prefix(prefix)) => {
            matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
        }
        _ => false,
    }
}

#[cfg(not(windows))]
fn starts_with_drive(_path: &Path) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::is_local_drive_path;
    use std::path::Path;

    fn assert_rejected(path: &str) {
        assert!(
            !is_local_drive_path(Path::new(path)),
            "拒否されるべきパスが通った: {path}"
        );
    }

    /// `//server/share` は Windows 以外では絶対パスなので、Windows でだけ確かめる
    #[test]
    #[cfg(windows)]
    fn unc形式とデバイスパスを拒否する() {
        assert_rejected("\\\\attacker.invalid\\share");
        assert_rejected("//attacker.invalid/share");
        assert_rejected("\\\\?\\UNC\\attacker.invalid\\share");
        assert_rejected("\\\\.\\C:\\SSP");
    }

    #[test]
    fn 相対パスとドライブ相対を拒否する() {
        assert_rejected("SSP");
        assert_rejected("..\\SSP");
        assert_rejected("\\SSP");
        assert_rejected("C:SSP");
        assert_rejected("");
    }

    #[test]
    fn 親ディレクトリ参照を含むパスを拒否する() {
        assert_rejected("C:\\SSP\\..\\Other");
        assert_rejected("\\\\?\\C:\\SSP\\..\\Other");
    }

    #[test]
    #[cfg(windows)]
    fn ドライブ文字で始まる絶対パスは通す() {
        for path in ["C:\\SSP", "Z:\\Apps\\SSP", "c:/ssp", "\\\\?\\C:\\SSP"] {
            assert!(is_local_drive_path(Path::new(path)), "{path}");
        }
    }
}
