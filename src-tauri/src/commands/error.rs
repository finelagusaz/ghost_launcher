use std::fmt;

use serde::Serialize;
#[cfg(test)]
use ts_rs::TS;

/// UI へ届くコマンドエラー。利用者が対処できる失敗は種別（`kind`）と引数で返し、
/// 文言はフロントエンドが i18n リソースから組み立てる（Rust の文字列をそのまま
/// 画面へ出すと、UI の言語に関係なく日本語が出るため）。
///
/// 種別を持たない内部失敗（DB エラー等）は `Internal` に生の詳細を載せる。フロントは
/// 詳細をそのまま「詳細」欄へ出す。`From<String>` で既存の `?` 伝播をそのまま受ける。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export))]
pub enum CommandError {
    /// 指定フォルダに ssp.exe が無い
    SspExeNotFound { path: String },
    /// ssp.exe のプロセス起動に失敗した（`detail` は OS のエラー文）
    SspLaunchFailed { detail: String },
    /// 必須の ghost フォルダ（`{ssp_path}/ghost`）が無い
    GhostFolderNotFound { path: String },
    /// 必須の ghost フォルダがディレクトリでない
    GhostFolderNotDirectory { path: String },
    /// 必須の ghost フォルダを読み取れない（`detail` は OS のエラー文）
    GhostFolderUnreadable { path: String, detail: String },
    /// 別のディレクトリが NFKC 畳み込みで同じゴースト identity になった
    GhostIdentityCollision { first: String, second: String },
    /// 上記以外の内部失敗
    Internal { detail: String },
}

/// ログ・テスト向けの開発者用文言。UI はこれを使わず `kind` から文言を組み立てる。
impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SspExeNotFound { path } => write!(f, "ssp.exe が見つかりません: {path}"),
            Self::SspLaunchFailed { detail } => write!(f, "SSP の起動に失敗しました: {detail}"),
            Self::GhostFolderNotFound { path } => {
                write!(f, "ghost フォルダが見つかりません: {path}")
            }
            Self::GhostFolderNotDirectory { path } => {
                write!(f, "ghost フォルダがディレクトリではありません: {path}")
            }
            Self::GhostFolderUnreadable { path, detail } => {
                write!(f, "ディレクトリを読み取れませんでした ({path}): {detail}")
            }
            Self::GhostIdentityCollision { first, second } => write!(
                f,
                "ゴースト identity が衝突しています（NFKC 畳み込みで別ディレクトリが同一キーに）: {first} / {second}"
            ),
            Self::Internal { detail } => f.write_str(detail),
        }
    }
}

impl From<String> for CommandError {
    fn from(detail: String) -> Self {
        Self::Internal { detail }
    }
}

/// `Result<_, String>` を返すテスト・ベンチから `?` で受けるための変換（本番には消費者が無い）。
#[cfg(any(test, feature = "bench"))]
impl From<CommandError> for String {
    fn from(error: CommandError) -> Self {
        error.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::CommandError;

    #[test]
    fn 種別はkindタグとキャメルケースで直列化される() {
        let json = serde_json::to_value(CommandError::GhostFolderUnreadable {
            path: "C:/ssp/ghost".to_string(),
            detail: "denied".to_string(),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "kind": "ghostFolderUnreadable",
                "path": "C:/ssp/ghost",
                "detail": "denied",
            })
        );
    }

    #[test]
    fn 文字列エラーはinternalに包まれる() {
        let error: CommandError = "database is locked".to_string().into();
        assert_eq!(
            error,
            CommandError::Internal {
                detail: "database is locked".to_string()
            }
        );
        assert_eq!(String::from(error), "database is locked");
    }
}
