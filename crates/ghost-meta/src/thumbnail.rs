use crate::descript::parse_descript;
use std::collections::HashMap;
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
pub fn resolve_thumbnail(
    ghost_root: &Path,
    shell_descript: Option<&HashMap<String, String>>,
) -> Option<ThumbnailInfo> {
    if let Some(info) = resolve_surface0(ghost_root, shell_descript) {
        return Some(info);
    }

    let thumbnail_path = ghost_root.join(THUMBNAIL_FILENAME);
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

/// `thumbnail.png` のファイル名（ゴーストのディレクトリ直下）。
const THUMBNAIL_FILENAME: &str = "thumbnail.png";

/// surface0* 画像の種別。
enum Surface0Ext {
    Apng,
    Png,
}

/// ファイル名が surface0* 画像（`surface` + 1 つ以上の `0` + `.png`/`.apng`、大文字小文字を問わない）なら
/// その種別を返す。`resolve_surface0` と `is_thumbnail_candidate` の単一権威。
fn surface0_extension(filename: &str) -> Option<Surface0Ext> {
    let lower = filename.to_ascii_lowercase();
    let rest = lower.strip_prefix("surface")?;
    let trimmed = rest.trim_start_matches('0');
    // 少なくとも 1 つの '0' があり、残りが ".png" または ".apng" であればマッチ
    if rest.len() == trimmed.len() {
        return None;
    }
    match trimmed {
        ".apng" => Some(Surface0Ext::Apng),
        ".png" => Some(Surface0Ext::Png),
        _ => None,
    }
}

/// `path` がゴーストのサムネイルとして成り立つ形かを返す。サムネイルを webview へ渡す読み取り口が、
/// 任意のファイルを読ませないための判定に使う。
///
/// 成り立つ形（`resolve_thumbnail` が選び得るファイル）:
/// - `{ghost_root}/thumbnail.png`
/// - `{ghost_root}/shell/master/surface0*.png` / `.apng`
///
/// かつ `{ghost_root}/ghost/master/descript.txt` が在る（ゴーストのディレクトリである）こと。
///
/// 「いま `resolve_thumbnail` が選ぶ 1 枚」とは照合しない。キャッシュに残る古いパスも描けるように
/// するためで、ファイルの有無も問わない（読む側が確かめる）。パスは正規化しない
/// （junction 越しのゴーストを通すため）。`..` を含むパスの拒否は呼び出し側の責務。
pub fn is_thumbnail_candidate(path: &Path) -> bool {
    let Some(filename) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let ghost_root = if filename == THUMBNAIL_FILENAME {
        path.parent()
    } else if surface0_extension(filename).is_some() {
        path.parent()
            .filter(|master| master.file_name().is_some_and(|name| name == "master"))
            .and_then(Path::parent)
            .filter(|shell| shell.file_name().is_some_and(|name| name == "shell"))
            .and_then(Path::parent)
    } else {
        None
    };
    ghost_root.is_some_and(|root| {
        root.join("ghost")
            .join("master")
            .join("descript.txt")
            .is_file()
    })
}

/// shell/master/ 内の surface0* ファイルを探して ThumbnailInfo を返す
fn resolve_surface0(
    ghost_root: &Path,
    shell_descript: Option<&HashMap<String, String>>,
) -> Option<ThumbnailInfo> {
    let shell_master = ghost_root.join("shell").join("master");

    let mut apng_files: Vec<String> = Vec::new();
    let mut png_files: Vec<String> = Vec::new();

    for entry in fs::read_dir(&shell_master).ok()?.flatten() {
        let filename = entry.file_name().to_string_lossy().into_owned();
        match surface0_extension(&filename) {
            Some(Surface0Ext::Apng) => apng_files.push(filename),
            Some(Surface0Ext::Png) => png_files.push(filename),
            None => {}
        }
    }

    // OS 依存の列挙順を回避するためソートして最初を選ぶ
    apng_files.sort_by_key(|f| f.to_ascii_lowercase());
    png_files.sort_by_key(|f| f.to_ascii_lowercase());

    // APNG が PNG より優先。選ばれたファイルを 1 つに決める
    let filename = apng_files.first().or_else(|| png_files.first())?;
    let path = shell_master.join(filename);

    // 実画像が本物のアルファチャンネルを持つ場合は宣言に関わらず SelfAlpha を優先する。
    // （seriko.use_self_alpha 未宣言の RGBA サーフェスがキーカラー抜きへ流れて
    // 黒消えする不具合の根本対策。アルファを持たないときだけ descript 宣言に従う）
    let alpha = if png_has_alpha_channel(&path) {
        AlphaMode::SelfAlpha
    } else {
        match shell_descript {
            Some(fields) => seriko_alpha_from_fields(fields),
            None => read_seriko_use_self_alpha(ghost_root),
        }
    };

    Some(ThumbnailInfo {
        path,
        alpha,
        kind: ThumbnailKind::Surface,
    })
}

/// HashMap から seriko.use_self_alpha を判定する。
fn seriko_alpha_from_fields(fields: &HashMap<String, String>) -> AlphaMode {
    if fields.get("seriko.use_self_alpha").map(|v| v.as_str()) == Some("1") {
        AlphaMode::SelfAlpha
    } else {
        AlphaMode::KeyColor
    }
}

/// shell/master/descript.txt から seriko.use_self_alpha を読み取る。
/// 値が "1" なら SelfAlpha、それ以外または欠落なら KeyColor。
fn read_seriko_use_self_alpha(ghost_root: &Path) -> AlphaMode {
    let shell_descript = ghost_root.join("shell").join("master").join("descript.txt");
    if let Ok(fields) = parse_descript(&shell_descript)
        && fields.get("seriko.use_self_alpha").map(|v| v.as_str()) == Some("1")
    {
        return AlphaMode::SelfAlpha;
    }
    AlphaMode::KeyColor
}

/// PNG/APNG が本物のアルファチャンネルを持つか検査する。
/// feature: "thumbnail" が有効な場合、IHDR ヘッダーのみ読み込んで color type を検査する
/// （全ピクセル展開はしない）。feature が無効な場合は常に false を返す。
#[cfg(feature = "thumbnail")]
fn png_has_alpha_channel(path: &Path) -> bool {
    use image::ColorType;
    use image::ImageDecoder;
    use image::codecs::png::PngDecoder;

    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    // PngDecoder は BufRead + Seek を要求するため BufReader で包む
    let Ok(decoder) = PngDecoder::new(std::io::BufReader::new(file)) else {
        return false;
    };
    // color_type() は ImageDecoder トレイトのメソッド。IHDR チャンクのみ参照する
    matches!(
        decoder.color_type(),
        ColorType::Rgba8 | ColorType::La8 | ColorType::Rgba16 | ColorType::La16
    )
}

#[cfg(not(feature = "thumbnail"))]
fn png_has_alpha_channel(_path: &Path) -> bool {
    false
}

/// thumbnail.png のアルファチャンネルの有無を AlphaMode へ写す。
/// アルファ持ちなら SelfAlpha、なければ KeyColor。
fn detect_thumbnail_alpha(path: &Path) -> AlphaMode {
    if png_has_alpha_channel(path) {
        AlphaMode::SelfAlpha
    } else {
        AlphaMode::KeyColor
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDirGuard;
    use std::path::PathBuf;

    fn create_shell_master(ghost_root: &Path) -> PathBuf {
        let shell_master = ghost_root.join("shell").join("master");
        fs::create_dir_all(&shell_master).unwrap();
        shell_master
    }

    fn write_shell_descript(ghost_root: &Path, content: &str) {
        let shell_master = create_shell_master(ghost_root);
        fs::write(shell_master.join("descript.txt"), content).unwrap();
    }

    // --- フォールバックチェーン ---

    #[test]
    fn shell_master_がない場合はnoneを返す() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_no_shell");
        let result = resolve_thumbnail(tmp.path(), None);
        assert!(result.is_none());
    }

    #[test]
    fn surface0もthumbnailpngもない場合はnoneを返す() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_nothing");
        create_shell_master(tmp.path());
        let result = resolve_thumbnail(tmp.path(), None);
        assert!(result.is_none());
    }

    #[test]
    fn surface0_pngが見つかる() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_surface0_png");
        let shell_master = create_shell_master(tmp.path());
        fs::write(shell_master.join("surface0.png"), "").unwrap();

        let info = resolve_thumbnail(tmp.path(), None).unwrap();
        assert_eq!(info.path, shell_master.join("surface0.png"));
        assert_eq!(info.kind, ThumbnailKind::Surface);
    }

    #[test]
    fn surface0_apngはpngより優先される() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_apng_priority");
        let shell_master = create_shell_master(tmp.path());
        fs::write(shell_master.join("surface0.apng"), "").unwrap();
        fs::write(shell_master.join("surface0.png"), "").unwrap();

        let info = resolve_thumbnail(tmp.path(), None).unwrap();
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

        let info = resolve_thumbnail(tmp.path(), None).unwrap();
        assert_eq!(info.path, shell_master.join("surface0.png"));
    }

    #[test]
    fn thumbnailpng_フォールバック() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_thumbnail_fallback");
        // shell/master はあるが surface0* なし
        create_shell_master(tmp.path());
        let thumbnail_path = tmp.path().join("thumbnail.png");
        fs::write(&thumbnail_path, "").unwrap();

        let info = resolve_thumbnail(tmp.path(), None).unwrap();
        assert_eq!(info.path, thumbnail_path);
        assert_eq!(info.kind, ThumbnailKind::Thumbnail);
    }

    #[test]
    fn surface0があればthumbnailpngより優先される() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_surface_over_thumb");
        let shell_master = create_shell_master(tmp.path());
        fs::write(shell_master.join("surface0.png"), "").unwrap();
        fs::write(tmp.path().join("thumbnail.png"), "").unwrap();

        let info = resolve_thumbnail(tmp.path(), None).unwrap();
        assert_eq!(info.path, shell_master.join("surface0.png"));
    }

    // --- seriko.use_self_alpha ---

    #[test]
    fn seriko_use_self_alpha_1でself_alphaになる() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_self_alpha");
        let shell_master = create_shell_master(tmp.path());
        write_shell_descript(tmp.path(), "charset,UTF-8\nseriko.use_self_alpha,1\n");
        fs::write(shell_master.join("surface0.png"), "").unwrap();

        let info = resolve_thumbnail(tmp.path(), None).unwrap();
        assert_eq!(info.alpha, AlphaMode::SelfAlpha);
    }

    #[test]
    fn seriko_use_self_alpha_0でkey_colorになる() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_key_color_0");
        let shell_master = create_shell_master(tmp.path());
        write_shell_descript(tmp.path(), "charset,UTF-8\nseriko.use_self_alpha,0\n");
        fs::write(shell_master.join("surface0.png"), "").unwrap();

        let info = resolve_thumbnail(tmp.path(), None).unwrap();
        assert_eq!(info.alpha, AlphaMode::KeyColor);
    }

    #[test]
    fn seriko_use_self_alpha_なしでkey_colorになる() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_key_color_missing");
        let shell_master = create_shell_master(tmp.path());
        write_shell_descript(tmp.path(), "charset,UTF-8\n");
        fs::write(shell_master.join("surface0.png"), "").unwrap();

        let info = resolve_thumbnail(tmp.path(), None).unwrap();
        assert_eq!(info.alpha, AlphaMode::KeyColor);
    }

    // --- surface0 パターンマッチ ---

    #[test]
    fn surface_pngはマッチしない() {
        // "surface.png" — '0' が 1 つもない
        let tmp = TempDirGuard::new("ghost_meta_thumb_no_match_surface");
        let shell_master = create_shell_master(tmp.path());
        fs::write(shell_master.join("surface.png"), "").unwrap();

        let result = resolve_thumbnail(tmp.path(), None);
        assert!(result.is_none());
    }

    #[test]
    fn surface1_pngはマッチしない() {
        // "surface1.png" — '0' で始まらない
        let tmp = TempDirGuard::new("ghost_meta_thumb_no_match_surface1");
        let shell_master = create_shell_master(tmp.path());
        fs::write(shell_master.join("surface1.png"), "").unwrap();

        let result = resolve_thumbnail(tmp.path(), None);
        assert!(result.is_none());
    }

    #[test]
    fn surface0x_pngはマッチしない() {
        // "surface0x.png" — '0' の後が ".png" でも ".apng" でもない
        let tmp = TempDirGuard::new("ghost_meta_thumb_no_match_surface0x");
        let shell_master = create_shell_master(tmp.path());
        fs::write(shell_master.join("surface0x.png"), "").unwrap();

        let result = resolve_thumbnail(tmp.path(), None);
        assert!(result.is_none());
    }

    #[test]
    fn ファイル名は大文字小文字不問でマッチする() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_case_insensitive");
        let shell_master = create_shell_master(tmp.path());
        fs::write(shell_master.join("Surface0.PNG"), "").unwrap();

        let info = resolve_thumbnail(tmp.path(), None).unwrap();
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

    // --- surface0 実画像アルファ検査（宣言より実体を優先） ---

    #[cfg(feature = "thumbnail")]
    #[test]
    fn surface0がrgbaなら宣言なしでもself_alphaになる() {
        use image::{ImageBuffer, Rgba};
        let tmp = TempDirGuard::new("ghost_meta_surface_rgba_self_alpha");
        let shell_master = create_shell_master(tmp.path());
        // descript も seriko.use_self_alpha 宣言もない。実画像のアルファのみで判定させる
        let img: image::RgbaImage = ImageBuffer::from_pixel(2, 2, Rgba([0u8, 0, 0, 0]));
        img.save(shell_master.join("surface0.png")).unwrap();

        let info = resolve_thumbnail(tmp.path(), None).unwrap();
        assert_eq!(info.alpha, AlphaMode::SelfAlpha);
    }

    #[cfg(feature = "thumbnail")]
    #[test]
    fn surface0がrgbで宣言なしならkey_colorのまま() {
        use image::{ImageBuffer, Rgb};
        let tmp = TempDirGuard::new("ghost_meta_surface_rgb_key_color");
        let shell_master = create_shell_master(tmp.path());
        // アルファチャンネルを持たない画像は従来どおりキーカラー抜き対象
        let img: image::RgbImage = ImageBuffer::from_pixel(2, 2, Rgb([0u8, 255, 0]));
        img.save(shell_master.join("surface0.png")).unwrap();

        let info = resolve_thumbnail(tmp.path(), None).unwrap();
        assert_eq!(info.alpha, AlphaMode::KeyColor);
    }

    #[cfg(feature = "thumbnail")]
    #[test]
    fn surface0がrgbでも宣言があればself_alphaになる() {
        use image::{ImageBuffer, Rgb};
        let tmp = TempDirGuard::new("ghost_meta_surface_rgb_declared_self_alpha");
        let shell_master = create_shell_master(tmp.path());
        // アルファ非保持でも descript 宣言があれば SelfAlpha を維持（フォールバック）
        write_shell_descript(tmp.path(), "charset,UTF-8\nseriko.use_self_alpha,1\n");
        let img: image::RgbImage = ImageBuffer::from_pixel(2, 2, Rgb([0u8, 255, 0]));
        img.save(shell_master.join("surface0.png")).unwrap();

        let info = resolve_thumbnail(tmp.path(), None).unwrap();
        assert_eq!(info.alpha, AlphaMode::SelfAlpha);
    }

    #[cfg(not(feature = "thumbnail"))]
    #[test]
    fn thumbnail_feature無効時はthumbnailpngをkey_colorとして返す() {
        let tmp = TempDirGuard::new("ghost_meta_thumb_no_feature");
        create_shell_master(tmp.path());
        let thumbnail_path = tmp.path().join("thumbnail.png");
        fs::write(&thumbnail_path, "").unwrap();

        let info = resolve_thumbnail(tmp.path(), None).unwrap();
        assert_eq!(info.path, thumbnail_path);
        assert_eq!(info.alpha, AlphaMode::KeyColor);
    }

    // --- is_thumbnail_candidate ---

    fn create_ghost_root(base: &Path, name: &str) -> PathBuf {
        let root = base.join(name);
        fs::create_dir_all(root.join("ghost").join("master")).unwrap();
        fs::write(
            root.join("ghost").join("master").join("descript.txt"),
            "name,A\n",
        )
        .unwrap();
        root
    }

    #[test]
    fn 候補_ゴースト直下のthumbnailpngは候補() {
        let tmp = TempDirGuard::new("ghost_meta_candidate_thumbnail");
        let root = create_ghost_root(tmp.path(), "g");
        assert!(is_thumbnail_candidate(&root.join("thumbnail.png")));
    }

    #[test]
    fn 候補_shell_masterのsurface0系は候補() {
        let tmp = TempDirGuard::new("ghost_meta_candidate_surface");
        let root = create_ghost_root(tmp.path(), "g");
        let master = root.join("shell").join("master");
        assert!(is_thumbnail_candidate(&master.join("surface0.png")));
        assert!(is_thumbnail_candidate(&master.join("surface00.apng")));
        assert!(is_thumbnail_candidate(&master.join("Surface0.PNG")));
    }

    #[test]
    fn 候補_サムネイルの名前でないファイルは候補でない() {
        let tmp = TempDirGuard::new("ghost_meta_candidate_other_names");
        let root = create_ghost_root(tmp.path(), "g");
        let master = root.join("shell").join("master");
        assert!(!is_thumbnail_candidate(&master.join("surface1.png")));
        assert!(!is_thumbnail_candidate(&master.join("surface.png")));
        assert!(!is_thumbnail_candidate(&master.join("descript.txt")));
        assert!(!is_thumbnail_candidate(&root.join("readme.png")));
        assert!(!is_thumbnail_candidate(
            &root.join("ghost").join("master").join("descript.txt")
        ));
    }

    #[test]
    fn 候補_ゴーストのディレクトリでなければ候補でない() {
        let tmp = TempDirGuard::new("ghost_meta_candidate_not_ghost");
        // ghost/master/descript.txt を持たないディレクトリ
        let plain = tmp.path().join("plain");
        fs::create_dir_all(plain.join("shell").join("master")).unwrap();
        assert!(!is_thumbnail_candidate(&plain.join("thumbnail.png")));
        assert!(!is_thumbnail_candidate(
            &plain.join("shell").join("master").join("surface0.png")
        ));
    }

    #[test]
    fn 候補_surface0はshell_masterの直下でなければ候補でない() {
        let tmp = TempDirGuard::new("ghost_meta_candidate_wrong_dir");
        let root = create_ghost_root(tmp.path(), "g");
        assert!(!is_thumbnail_candidate(&root.join("surface0.png")));
        assert!(!is_thumbnail_candidate(
            &root.join("master").join("surface0.png")
        ));
        assert!(!is_thumbnail_candidate(
            &root.join("shell").join("other").join("surface0.png")
        ));
    }

    #[test]
    fn 候補_ファイルの有無は問わない() {
        // 呼び出し側（読み取り）が存在を確かめる。形の判定はキャッシュの古いパスにも当てられる
        let tmp = TempDirGuard::new("ghost_meta_candidate_missing_file");
        let root = create_ghost_root(tmp.path(), "g");
        assert!(!root.join("thumbnail.png").exists());
        assert!(is_thumbnail_candidate(&root.join("thumbnail.png")));
    }
}
