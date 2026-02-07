use encoding_rs::{SHIFT_JIS, UTF_8};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

const CHARSET_SCAN_LIMIT: usize = 4096;

enum Charset {
    Utf8,
    ShiftJis,
}

/// descript.txt をパースしてキー・バリューの HashMap を返す。
/// charset フィールドに応じて Shift_JIS または UTF-8 でデコードする。
pub fn parse_descript(path: &Path) -> Result<HashMap<String, String>, String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

    // まず UTF-8 BOM チェック
    let content = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&bytes[3..]).into_owned()
    } else {
        // 先頭だけで charset を探して全体デコードに使う
        let charset = detect_charset(&bytes);
        decode_with_charset(&bytes, charset)
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

/// バイト列先頭から charset フィールドを検出する（ASCII 互換部分のみで判定）
fn detect_charset(bytes: &[u8]) -> Charset {
    let scan_len = bytes.len().min(CHARSET_SCAN_LIMIT);
    let ascii_content = String::from_utf8_lossy(&bytes[..scan_len]);
    for line in ascii_content.lines() {
        let line = line.trim();
        if let Some((key, value)) = line.split_once(',') {
            if key.trim().eq_ignore_ascii_case("charset") {
                if value.trim().eq_ignore_ascii_case("UTF-8") {
                    return Charset::Utf8;
                }
                return Charset::ShiftJis;
            }
        }
    }
    // デフォルトは Shift_JIS
    Charset::ShiftJis
}

/// 指定された文字コードでバイト列をデコードする
fn decode_with_charset(bytes: &[u8], charset: Charset) -> String {
    match charset {
        Charset::Utf8 => {
            let (cow, _, _) = UTF_8.decode(bytes);
            cow.into_owned()
        }
        Charset::ShiftJis => {
            let (cow, _, _) = SHIFT_JIS.decode(bytes);
            cow.into_owned()
        }
    }
}
