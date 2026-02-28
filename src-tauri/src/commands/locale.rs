use std::path::Path;

const MAX_LOCALE_BYTES: u64 = 1_024 * 1_024; // 1 MB

/// ディレクトリ配下の locales/{lang}.json を読み込む（テスト用に分離）
fn read_locale_from_dir(dir: &Path, lang: &str) -> Result<Option<String>, String> {
    let locale_path = dir.join("locales").join(format!("{lang}.json"));

    if !locale_path.exists() {
        return Ok(None);
    }

    // ファイルサイズ確認（TOCTOU 対策のため metadata を open 前に取得）
    let metadata = std::fs::metadata(&locale_path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_LOCALE_BYTES {
        return Err(format!(
            "言語ファイルが大きすぎます（最大 1 MB）: {lang}"
        ));
    }

    let content = std::fs::read_to_string(&locale_path).map_err(|e| e.to_string())?;
    Ok(Some(content))
}

/// 実行ファイル横の locales/{lang}.json を読み込む Tauri コマンド。
/// ファイルが存在しない場合は null を返す。
#[tauri::command]
pub fn read_user_locale(lang: String) -> Result<Option<String>, String> {
    // パストラバーサル対策: 言語コードは英数字・ハイフン・アンダースコアのみ許可
    if !lang
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("無効な言語コードです: {lang}"));
    }

    let exe_dir = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "実行ファイルのディレクトリを特定できません".to_string())?;

    read_locale_from_dir(&exe_dir, &lang)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDirGuard {
        path: PathBuf,
    }

    impl TempDirGuard {
        fn new(prefix: &str) -> Result<Self, String> {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos();
            let path = std::env::temp_dir().join(format!("{prefix}_{nanos}"));
            fs::create_dir_all(&path).map_err(|e| e.to_string())?;
            Ok(Self { path })
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
    fn locales_フォルダがない場合は_none_を返す() {
        let dir = TempDirGuard::new("locale_test").unwrap();
        let result = read_locale_from_dir(dir.path(), "ja");
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn 言語ファイルが存在する場合は内容を返す() {
        let dir = TempDirGuard::new("locale_test").unwrap();
        let locales_dir = dir.path().join("locales");
        fs::create_dir_all(&locales_dir).unwrap();
        fs::write(locales_dir.join("ja.json"), r#"{"card.launch":"起動"}"#).unwrap();

        let result = read_locale_from_dir(dir.path(), "ja");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), Some(r#"{"card.launch":"起動"}"#.to_string()));
    }

    #[test]
    fn 存在しない言語コードの場合は_none_を返す() {
        let dir = TempDirGuard::new("locale_test").unwrap();
        let locales_dir = dir.path().join("locales");
        fs::create_dir_all(&locales_dir).unwrap();
        fs::write(locales_dir.join("ja.json"), r#"{}"#).unwrap();

        let result = read_locale_from_dir(dir.path(), "fr");
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn ファイルサイズ超過の場合はエラーを返す() {
        let dir = TempDirGuard::new("locale_test").unwrap();
        let locales_dir = dir.path().join("locales");
        fs::create_dir_all(&locales_dir).unwrap();
        // 1 MB + 1 byte のダミーファイル
        let oversized = vec![b'x'; (MAX_LOCALE_BYTES + 1) as usize];
        fs::write(locales_dir.join("en.json"), &oversized).unwrap();

        let result = read_locale_from_dir(dir.path(), "en");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("大きすぎます"));
    }

    #[test]
    fn 不正な言語コードはエラーを返す() {
        let result = read_user_locale("../../etc/passwd".to_string());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("無効な言語コード"));
    }
}
