use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ghost {
    /// 差分更新判定用の軽量フィンガープリント
    pub diff_fingerprint: String,
    /// descript.txt の name フィールド（表示名）
    pub name: String,
    /// descript.txt の sakura.name フィールド（\0 キャラ名）。未設定の場合は空文字列
    pub sakura_name: String,
    /// descript.txt の kero.name フィールド（\1 キャラ名）。未設定の場合は空文字列
    pub kero_name: String,
    /// descript.txt の craftman フィールド（作者名）。未設定の場合は空文字列
    pub craftman: String,
    /// descript.txt の craftmanw フィールド（作者名2）。未設定の場合は空文字列
    pub craftmanw: String,
    /// ゴーストのディレクトリ名（SSP起動時に使用）
    pub directory_name: String,
    /// ゴーストのフルパス
    pub path: String,
    /// ゴーストの出自（"ssp" or 追加フォルダのパス）
    pub source: String,
    /// サムネイル画像のフルパス。存在しない場合は空文字列
    pub thumbnail_path: String,
    /// サムネイルの透過方式。true = PNG アルファチャンネル、false = 左上ピクセルをキーカラーとして透過
    pub thumbnail_use_self_alpha: bool,
    /// サムネイルの種別。"surface" / "thumbnail" / ""（サムネイルなし）
    pub thumbnail_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanGhostsResponse {
    pub ghosts: Vec<Ghost>,
    pub fingerprint: String,
}
