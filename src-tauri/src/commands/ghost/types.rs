use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Ghost {
    /// descript.txt の name フィールド（表示名）
    pub name: String,
    /// ゴーストのディレクトリ名（SSP起動時に使用）
    pub directory_name: String,
    /// ゴーストのフルパス
    pub path: String,
    /// ゴーストの出自（"ssp" or 追加フォルダのパス）
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanGhostsResponse {
    pub ghosts: Vec<Ghost>,
    pub fingerprint: String,
}
