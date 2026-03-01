use crate::descript::parse_descript;
use std::fs;
use std::path::{Path, PathBuf};

/// サムネイルの透過モード
#[derive(Debug, Clone, PartialEq)]
pub enum AlphaMode {
    /// PNG のアルファチャンネルを使用して透過する
    SelfAlpha,
    /// 左上ピクセルをキーカラーとして透過する
    KeyColor,
}

/// サムネイル画像の種別
#[derive(Debug, Clone, PartialEq)]
pub enum ThumbnailKind {
    /// shell/master/surface0* 画像
    Surface,
    /// ゴーストルート直下の thumbnail.png
    Thumbnail,
}

/// 解決済みサムネイルの情報
#[derive(Debug, Clone)]
pub struct ThumbnailInfo {
    pub path: PathBuf,
    pub alpha: AlphaMode,
    pub kind: ThumbnailKind,
}

/// ゴーストのサムネイル画像を解決する。
///
/// フォールバックチェーン（優先度順）:
/// 1. `shell/master/surface0*.apng` — seriko.use_self_alpha を参照
/// 2. `shell/master/surface0*.png`  — seriko.use_self_alpha を参照
/// 3. `thumbnail.png`（ghost_root 直下）— PNG アルファチャンネルの有無を検査
/// 4. `None`
///
/// surface0* の選択: 名前辞書順の最初（OS 依存の列挙順を回避するためソートする）
pub fn resolve_thumbnail(ghost_root: &Path) -> Option<ThumbnailInfo> {
    if let Some(info) = resolve_surface0(ghost_root) {
        return Some(info);
    }

    let thumbnail_path = ghost_root.join("thumbnail.png");
    if thumbnail_path.is_file() {
        let alpha = detect_thumbnail_alpha(&thumbnail_path);
        return Some(ThumbnailInfo {
            path: thumbnail_path,
            alpha,
            kind: ThumbnailKind::Thumbnail,
        });
    }

    None
}

/// shell/master/ 内の surface0* ファイルを探して ThumbnailInfo を返す
fn resolve_surface0(ghost_root: &Path) -> Option<ThumbnailInfo> {
    let shell_master = ghost_root.join("shell").join("master");
    if !shell_master.is_dir() {
        return None;
    }

    let mut apng_files: Vec<String> = Vec::new();
    let mut png_files: Vec<String> = Vec::new();

    for entry in fs::read_dir(&shell_master).ok()?.flatten() {
        let filename = entry.file_name().to_string_lossy().into_owned();
        let lower = filename.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("surface") {
            let trimmed = rest.trim_start_matches('0');
            // 少なくとも 1 つの '0' があり、残りが ".png" または ".apng" であればマッチ
            if rest.len() > trimmed.len() {
                if trimmed == ".apng" {
                    apng_files.push(filename);
                } else if trimmed == ".png" {
                    png_files.push(filename);
                }
            }
        }
    }

    // OS 依存の列挙順を回避するためソートして最初を選ぶ
    apng_files.sort_by_key(|f| f.to_ascii_lowercase());
    png_files.sort_by_key(|f| f.to_ascii_lowercase());

    let alpha = read_seriko_use_self_alpha(ghost_root);

    // APNG が PNG より優先
    if let Some(filename) = apng_files.first() {
        return Some(ThumbnailInfo {
            path: shell_master.join(filename),
            alpha,
            kind: ThumbnailKind::Surface,
        });
    }
    if let Some(filename) = png_files.first() {
        return Some(ThumbnailInfo {
            path: shell_master.join(filename),
            alpha,
            kind: ThumbnailKind::Surface,
        });
    }

    None
}

/// shell/master/descript.txt から seriko.use_self_alpha を読み取る。
/// 値が "1" なら SelfAlpha、それ以外または欠落なら KeyColor。
fn read_seriko_use_self_alpha(ghost_root: &Path) -> AlphaMode {
    let shell_descript = ghost_root
        .join("shell")
        .join("master")
        .join("descript.txt");
    if let Ok(fields) = parse_descript(&shell_descript) {
        if fields.get("seriko.use_self_alpha").map(|v| v.as_str()) == Some("1") {
            return AlphaMode::SelfAlpha;
        }
    }
    AlphaMode::KeyColor
}

/// thumbnail.png のアルファチャンネルを検査して AlphaMode を返す。
/// feature: "thumbnail" が有効な場合、PNG の IHDR ヘッダーのみ読み込んで color type を検査する。
/// feature が無効な場合は常に KeyColor を返す。
#[cfg(feature = "thumbnail")]
fn detect_thumbnail_alpha(path: &Path) -> AlphaMode {
    use image::codecs::png::PngDecoder;
    use image::ColorType;
    use image::ImageDecoder;

    let Ok(file) = fs::File::open(path) else {
        return AlphaMode::KeyColor;
    };
    // PngDecoder は BufRead + Seek を要求するため BufReader で包む
    let Ok(decoder) = PngDecoder::new(std::io::BufReader::new(file)) else {
        return AlphaMode::KeyColor;
    };
    // color_type() は ImageDecoder トレイトのメソッド。IHDR チャンクのみ参照し全ピクセル展開は行わない
    match decoder.color_type() {
        ColorType::Rgba8 | ColorType::La8 | ColorType::Rgba16 | ColorType::La16 => {
            AlphaMode::SelfAlpha
        }
        _ => AlphaMode::KeyColor,
    }
}

#[cfg(not(feature = "thumbnail"))]
fn detect_thumbnail_alpha(_path: &Path) -> AlphaMode {
    AlphaMode::KeyColor
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

    fn create_shell_master(ghost_root: &PathBuf) -> PathBuf {
        let shell_master = ghost_root.join("shell").join("master");
        fs::create_dir_all(&shell_master).unwrap();
        shell_master
    }

    fn write_shell_descript(ghost_root: &PathBuf, content: &str) {
        let shell_master = create_shell_master(ghost_root);
        fs::write(shell_master.join("descript.txt"), content).unwrap();
    }

    // --- フォールバックチェーン ---

    #[test]
    fn shell_master_がない場合はnoneを返す() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_no_shell");
        let result = resolve_thumbnail(tmp.path());
        assert!(result.is_none());
    }

    #[test]
    fn surface0もthumbnailpngもない場合はnoneを返す() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_nothing");
        create_shell_master(tmp.path());
        let result = resolve_thumbnail(tmp.path());
        assert!(result.is_none());
    }

    #[test]
    fn surface0_pngが見つかる() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_surface0_png");
        let shell_master = create_shell_master(tmp.path());
        fs::write(shell_master.join("surface0.png"), "").unwrap();

        let info = resolve_thumbnail(tmp.path()).unwrap();
        assert_eq!(info.path, shell_master.join("surface0.png"));
        assert_eq!(info.kind, ThumbnailKind::Surface);
    }

    #[test]
    fn surface0_apngはpngより優先される() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_apng_priority");
        let shell_master = create_shell_master(tmp.path());
        fs::write(shell_master.join("surface0.apng"), "").unwrap();
        fs::write(shell_master.join("surface0.png"), "").unwrap();

        let info = resolve_thumbnail(tmp.path()).unwrap();
        assert_eq!(info.path, shell_master.join("surface0.apng"));
    }

    #[test]
    fn surface0_複数ある場合アルファベット順最初を選ぶ() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_sort");
        let shell_master = create_shell_master(tmp.path());
        // surface00.png より surface0.png が先（`.` < `0`）
        fs::write(shell_master.join("surface00.png"), "").unwrap();
        fs::write(shell_master.join("surface0.png"), "").unwrap();
        fs::write(shell_master.join("surface000.png"), "").unwrap();

        let info = resolve_thumbnail(tmp.path()).unwrap();
        assert_eq!(info.path, shell_master.join("surface0.png"));
    }

    #[test]
    fn thumbnailpng_フォールバック() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_thumbnail_fallback");
        // shell/master はあるが surface0* なし
        create_shell_master(tmp.path());
        let thumbnail_path = tmp.path().join("thumbnail.png");
        fs::write(&thumbnail_path, "").unwrap();

        let info = resolve_thumbnail(tmp.path()).unwrap();
        assert_eq!(info.path, thumbnail_path);
        assert_eq!(info.kind, ThumbnailKind::Thumbnail);
    }

    #[test]
    fn surface0があればthumbnailpngより優先される() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_surface_over_thumb");
        let shell_master = create_shell_master(tmp.path());
        fs::write(shell_master.join("surface0.png"), "").unwrap();
        fs::write(tmp.path().join("thumbnail.png"), "").unwrap();

        let info = resolve_thumbnail(tmp.path()).unwrap();
        assert_eq!(info.path, shell_master.join("surface0.png"));
    }

    // --- seriko.use_self_alpha ---

    #[test]
    fn seriko_use_self_alpha_1でself_alphaになる() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_self_alpha");
        let shell_master = create_shell_master(tmp.path());
        write_shell_descript(tmp.path(), "charset,UTF-8\nseriko.use_self_alpha,1\n");
        fs::write(shell_master.join("surface0.png"), "").unwrap();

        let info = resolve_thumbnail(tmp.path()).unwrap();
        assert_eq!(info.alpha, AlphaMode::SelfAlpha);
    }

    #[test]
    fn seriko_use_self_alpha_0でkey_colorになる() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_key_color_0");
        let shell_master = create_shell_master(tmp.path());
        write_shell_descript(tmp.path(), "charset,UTF-8\nseriko.use_self_alpha,0\n");
        fs::write(shell_master.join("surface0.png"), "").unwrap();

        let info = resolve_thumbnail(tmp.path()).unwrap();
        assert_eq!(info.alpha, AlphaMode::KeyColor);
    }

    #[test]
    fn seriko_use_self_alpha_なしでkey_colorになる() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_key_color_missing");
        let shell_master = create_shell_master(tmp.path());
        write_shell_descript(tmp.path(), "charset,UTF-8\n");
        fs::write(shell_master.join("surface0.png"), "").unwrap();

        let info = resolve_thumbnail(tmp.path()).unwrap();
        assert_eq!(info.alpha, AlphaMode::KeyColor);
    }

    // --- surface0 パターンマッチ ---

    #[test]
    fn surface_pngはマッチしない() {
        // "surface.png" — '0' が 1 つもない
        let tmp = TempDirGuard::new("ghost_meta_thumb_no_match_surface");
        let shell_master = create_shell_master(tmp.path());
        fs::write(shell_master.join("surface.png"), "").unwrap();

        let result = resolve_thumbnail(tmp.path());
        assert!(result.is_none());
    }

    #[test]
    fn surface1_pngはマッチしない() {
        // "surface1.png" — '0' で始まらない
        let tmp = TempDirGuard::new("ghost_meta_thumb_no_match_surface1");
        let shell_master = create_shell_master(tmp.path());
        fs::write(shell_master.join("surface1.png"), "").unwrap();

        let result = resolve_thumbnail(tmp.path());
        assert!(result.is_none());
    }

    #[test]
    fn surface0x_pngはマッチしない() {
        // "surface0x.png" — '0' の後が ".png" でも ".apng" でもない
        let tmp = TempDirGuard::new("ghost_meta_thumb_no_match_surface0x");
        let shell_master = create_shell_master(tmp.path());
        fs::write(shell_master.join("surface0x.png"), "").unwrap();

        let result = resolve_thumbnail(tmp.path());
        assert!(result.is_none());
    }

    #[test]
    fn ファイル名は大文字小文字不問でマッチする() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_case_insensitive");
        let shell_master = create_shell_master(tmp.path());
        fs::write(shell_master.join("Surface0.PNG"), "").unwrap();

        let info = resolve_thumbnail(tmp.path()).unwrap();
        assert_eq!(info.path, shell_master.join("Surface0.PNG"));
    }

    // --- thumbnail feature: PNG アルファチャンネル検査 ---

    #[cfg(feature = "thumbnail")]
    #[test]
    fn thumbnail_png_rgba_はself_alphaを返す() {
        use image::{ImageBuffer, Rgba};
        let tmp = TempDirGuard::new("ghost_meta_thumb_rgba");
        let path = tmp.path().join("thumbnail.png");
        let img: image::RgbaImage = ImageBuffer::from_pixel(1, 1, Rgba([0u8, 0, 0, 128]));
        img.save(&path).unwrap();

        let alpha = detect_thumbnail_alpha(&path);
        assert_eq!(alpha, AlphaMode::SelfAlpha);
    }

    #[cfg(feature = "thumbnail")]
    #[test]
    fn thumbnail_png_rgb_はkey_colorを返す() {
        use image::{ImageBuffer, Rgb};
        let tmp = TempDirGuard::new("ghost_meta_thumb_rgb");
        let path = tmp.path().join("thumbnail.png");
        let img: image::RgbImage = ImageBuffer::from_pixel(1, 1, Rgb([255u8, 0, 0]));
        img.save(&path).unwrap();

        let alpha = detect_thumbnail_alpha(&path);
        assert_eq!(alpha, AlphaMode::KeyColor);
    }

    #[cfg(not(feature = "thumbnail"))]
    #[test]
    fn thumbnail_feature無効時はthumbnailpngをkey_colorとして返す() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_no_feature");
        create_shell_master(tmp.path());
        let thumbnail_path = tmp.path().join("thumbnail.png");
        fs::write(&thumbnail_path, "").unwrap();

        let info = resolve_thumbnail(tmp.path()).unwrap();
        assert_eq!(info.path, thumbnail_path);
        assert_eq!(info.alpha, AlphaMode::KeyColor);
    }
}
