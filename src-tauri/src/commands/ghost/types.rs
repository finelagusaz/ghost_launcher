use serde::{Deserialize, Serialize};
#[cfg(test)]
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export))]
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
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export))]
pub struct ScanGhostsResponse {
    /// フィンガープリントが一致した場合は空 Vec。DB 更新不要
    pub ghosts: Vec<Ghost>,
    pub fingerprint: String,
    /// true = キャッシュと一致、ghosts は空・DB 更新不要
    pub cache_hit: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// IPC 境界の JSON フィールド名が TS 型定義と一致することを保証する。
    /// フィールドの追加・リネーム時にこのテストが壊れるので、TS 側も同時に更新が必要。
    #[test]
    fn ghost_の_json_フィールド名が_ts_型と一致する() {
        let ghost = Ghost {
            diff_fingerprint: String::new(),
            name: String::new(),
            sakura_name: String::new(),
            kero_name: String::new(),
            craftman: String::new(),
            craftmanw: String::new(),
            directory_name: String::new(),
            path: String::new(),
            source: String::new(),
            thumbnail_path: String::new(),
            thumbnail_use_self_alpha: false,
            thumbnail_kind: String::new(),
        };
        let json: serde_json::Value = serde_json::to_value(&ghost).unwrap();
        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "craftman",
                "craftmanw",
                "diff_fingerprint",
                "directory_name",
                "kero_name",
                "name",
                "path",
                "sakura_name",
                "source",
                "thumbnail_kind",
                "thumbnail_path",
                "thumbnail_use_self_alpha",
            ]
        );
    }

    #[test]
    fn scan_ghosts_response_の_json_フィールド名が_ts_型と一致する() {
        let resp = ScanGhostsResponse {
            ghosts: vec![],
            fingerprint: String::new(),
            cache_hit: false,
        };
        let json: serde_json::Value = serde_json::to_value(&resp).unwrap();
        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(keys, vec!["cache_hit", "fingerprint", "ghosts"]);
    }
}
