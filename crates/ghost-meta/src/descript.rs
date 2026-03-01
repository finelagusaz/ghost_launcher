use crate::GhostMetaError;
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
pub fn parse_descript(path: &Path) -> Result<HashMap<String, String>, GhostMetaError> {
    let bytes = fs::read(path)?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDirGuard {
        path: PathBuf,
    }

    impl TempDirGuard {
        fn new(prefix: &str) -> Self {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("{}_{}", prefix, now));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn path(&self) -> &PathBuf {
            &self.path
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn utf8_bom_付きファイルをパースできる() {
        let tmp = TempDirGuard::new("ghost_meta_descript_bom");
        let file = tmp.path().join("descript.txt");
        // UTF-8 BOM + key,value
        let mut content = vec![0xEF, 0xBB, 0xBF];
        content.extend_from_slice(b"name,BOM Test\ncharset,UTF-8\n");
        fs::write(&file, content).unwrap();

        let result = parse_descript(&file).unwrap();
        assert_eq!(result.get("name"), Some(&"BOM Test".to_string()));
        assert_eq!(result.get("charset"), Some(&"UTF-8".to_string()));
    }

    #[test]
    fn charset_utf8_フィールドでutf8デコードされる() {
        let tmp = TempDirGuard::new("ghost_meta_descript_utf8");
        let file = tmp.path().join("descript.txt");
        fs::write(&file, "charset,UTF-8\nname,UTF-8テスト\n").unwrap();

        let result = parse_descript(&file).unwrap();
        assert_eq!(result.get("name"), Some(&"UTF-8テスト".to_string()));
    }

    #[test]
    fn コメント行と空行はスキップされる() {
        let tmp = TempDirGuard::new("ghost_meta_descript_comment");
        let file = tmp.path().join("descript.txt");
        fs::write(
            &file,
            "// this is a comment\n\ncharset,UTF-8\nname,ゴースト\n",
        )
        .unwrap();

        let result = parse_descript(&file).unwrap();
        assert!(!result.contains_key("// this is a comment"));
        assert_eq!(result.get("name"), Some(&"ゴースト".to_string()));
        // 空行のキーが混入しないこと
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn 存在しないファイルはioエラーを返す() {
        let result = parse_descript(Path::new("/nonexistent/descript.txt"));
        assert!(matches!(result, Err(GhostMetaError::Io(_))));
    }

    #[test]
    fn charset_sjis以外のフィールドはshift_jisフォールバックになる() {
        let tmp = TempDirGuard::new("ghost_meta_descript_sjis");
        let file = tmp.path().join("descript.txt");
        // Shift_JIS エンコードの「charset,Shift_JIS\nname,てすと\n」
        // "charset,Shift_JIS\n" は ASCII 互換なのでそのまま使える
        // "name,てすと\n" の Shift_JIS バイト列
        let mut bytes: Vec<u8> = b"charset,Shift_JIS\nname,".to_vec();
        // "てすと" の Shift_JIS: 0x82 0xC4 0x82 0xB7 0x82 0xC6
        bytes.extend_from_slice(&[0x82, 0xC4, 0x82, 0xB7, 0x82, 0xC6]);
        bytes.push(b'\n');
        fs::write(&file, &bytes).unwrap();

        let result = parse_descript(&file).unwrap();
        assert_eq!(result.get("name"), Some(&"てすと".to_string()));
    }

    #[test]
    fn charsetフィールドがない場合shift_jisデフォルトになる() {
        let tmp = TempDirGuard::new("ghost_meta_descript_default");
        let file = tmp.path().join("descript.txt");
        // ASCII のみ（Shift_JIS でも UTF-8 でも同じ結果になる）
        fs::write(&file, "name,ASCII Ghost\n").unwrap();

        let result = parse_descript(&file).unwrap();
        assert_eq!(result.get("name"), Some(&"ASCII Ghost".to_string()));
    }

    #[test]
    fn 値にカンマを含む場合は最初のカンマで分割する() {
        let tmp = TempDirGuard::new("ghost_meta_descript_comma");
        let file = tmp.path().join("descript.txt");
        fs::write(&file, "charset,UTF-8\ndescription,a,b,c\n").unwrap();

        let result = parse_descript(&file).unwrap();
        // split_once(',') なので最初のカンマで分割される
        assert_eq!(result.get("description"), Some(&"a,b,c".to_string()));
    }
}
