use encoding_rs::{SHIFT_JIS, UTF_8};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

/// descript.txt をパースしてキー・バリューの HashMap を返す。
/// charset フィールドに応じて Shift_JIS または UTF-8 でデコードする。
pub fn parse_descript(path: &Path) -> Result<HashMap<String, String>, String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

    // まず UTF-8 BOM チェック
    let content = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&bytes[3..]).into_owned()
    } else {
        // 先に ASCII 部分だけで charset を探す
        let charset = detect_charset(&bytes);
        decode_with_charset(&bytes, &charset)
    };

    let mut fields = HashMap::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        if let Some((key, value)) = line.split_once(',') {
            fields.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    Ok(fields)
}

/// バイト列から charset フィールドを検出する（ASCII 互換部分のみで判定）
fn detect_charset(bytes: &[u8]) -> String {
    // ASCII として読める範囲で charset 行を探す
    let ascii_content = String::from_utf8_lossy(bytes);
    for line in ascii_content.lines() {
        let line = line.trim();
        if let Some((key, value)) = line.split_once(',') {
            if key.trim().eq_ignore_ascii_case("charset") {
                return value.trim().to_string();
            }
        }
    }
    // デフォルトは Shift_JIS
    "Shift_JIS".to_string()
}

/// 指定された文字コードでバイト列をデコードする
fn decode_with_charset(bytes: &[u8], charset: &str) -> String {
    if charset.eq_ignore_ascii_case("UTF-8") {
        let (cow, _, _) = UTF_8.decode(bytes);
        cow.into_owned()
    } else {
        // Shift_JIS として処理
        let (cow, _, _) = SHIFT_JIS.decode(bytes);
        cow.into_owned()
    }
}
