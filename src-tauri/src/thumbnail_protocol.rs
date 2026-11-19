//! サムネイル画像を webview へ渡す読み取り専用のプロトコル（`thumbnail:`）。
//!
//! Tauri の asset プロトコルは許可範囲（scope）の中なら任意のファイルを読ませる。許可範囲を
//! SSP と追加フォルダの配下へ絞ると、junction で外を指すゴーストが読めなくなる（scope の照合は
//! 要求パスを正規化してから行う）うえ、範囲を足す前にキャッシュ表示が画像を要求する順序の
//! 問題も生じる。ここでは場所でなく形で絞る: ゴーストのサムネイルとして成り立つパス
//! （`ghost_meta::is_thumbnail_candidate`）だけを読み、それ以外は 404 を返す。状態を持たない。

use std::borrow::Cow;
use std::path::{Component, Path, PathBuf};

use tauri::http::{Request, Response, StatusCode, header::CONTENT_TYPE};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

/// プロトコル名。フロントエンドの `src/lib/thumbnailUrl.ts` と CSP の `img-src` が同じ名前を使う。
pub(crate) const SCHEME: &str = "thumbnail";

/// 読む画像の大きさの上限。サムネイルは小さい画像で、これを超えるものは読まない
/// （巨大なファイルを丸ごとメモリへ読まない）。
const MAX_THUMBNAIL_BYTES: u64 = 32 * 1024 * 1024;

/// プロトコルの入口。ファイル読みはメインスレッドで行わない。
pub(crate) fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    // canvas がピクセルを読む（キーカラー透過）ため、crossOrigin=anonymous の読み込みを
    // 通す。許可する Origin は、要求元の webview のページの Origin だけにする。
    // about:blank 等の不透明な Origin（"null"）には許可を出さない
    let origin = ctx
        .app_handle()
        .get_webview_window(ctx.webview_label())
        .and_then(|webview| webview.url().ok())
        .map(|url| url.origin())
        .filter(|origin| origin.is_tuple())
        .map(|origin| origin.ascii_serialization());
    let raw_path = request.uri().path().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        responder.respond(build_response(&raw_path, origin.as_deref()));
    });
}

fn build_response(raw_path: &str, origin: Option<&str>) -> Response<Cow<'static, [u8]>> {
    let mut builder = Response::builder();
    if let Some(origin) = origin {
        builder = builder.header("Access-Control-Allow-Origin", origin);
    }
    let result = match read_thumbnail(raw_path) {
        Ok((bytes, mime)) => builder
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, mime)
            .body(Cow::Owned(bytes)),
        Err(status) => builder.status(status).body(Cow::Borrowed(&[][..])),
    };
    result.unwrap_or_else(|_| {
        let mut response = Response::new(Cow::Borrowed(&[][..]));
        *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
        response
    })
}

/// 要求パスを読み、画像の中身と MIME 型を返す。読めないときは理由を問わず 404 を返す
/// （読ませないパスと無いファイルを区別すると、任意の場所にゴーストの形のディレクトリが
/// あるかを探れてしまう）。
fn read_thumbnail(raw_path: &str) -> Result<(Vec<u8>, &'static str), StatusCode> {
    use std::io::Read;

    let path = decode_request_path(raw_path)
        .filter(|path| is_servable(path))
        .ok_or(StatusCode::NOT_FOUND)?;
    // 開いたハンドルで種類と大きさを確かめ、そのまま読む（パスを解決し直さない）
    let file = std::fs::File::open(&path).map_err(|_| StatusCode::NOT_FOUND)?;
    let meta = file.metadata().map_err(|_| StatusCode::NOT_FOUND)?;
    if !meta.is_file() || meta.len() > MAX_THUMBNAIL_BYTES {
        return Err(StatusCode::NOT_FOUND);
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(MAX_THUMBNAIL_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|_| StatusCode::NOT_FOUND)?;
    Ok((bytes, mime_type(&path)))
}

/// URL のパス部（`convertFileSrc` が encodeURIComponent したファイルパス）をファイルパスへ戻す。
/// UTF-8 として不正なら None（化けた別名のファイルを読まない）。
fn decode_request_path(raw_path: &str) -> Option<PathBuf> {
    let encoded = raw_path.strip_prefix('/').unwrap_or(raw_path);
    let decoded = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .ok()?;
    Some(PathBuf::from(decoded.into_owned()))
}

/// 読ませてよいパスか。
/// - 絶対パスで、`..` を含まない（形の判定は正規化しないため、`..` で構造の外へ出させない）
/// - ローカルのドライブ（Windows）。UNC パスは、判定のためのファイル確認だけで任意のサーバへ
///   SMB 接続を起こすため受けない（割り当て済みのネットワークドライブは通る）
/// - ゴーストのサムネイルとして成り立つ形（`ghost_meta::is_thumbnail_candidate`）
fn is_servable(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        && is_drive_path(path)
        && ghost_meta::is_thumbnail_candidate(path)
}

#[cfg(windows)]
fn is_drive_path(path: &Path) -> bool {
    use std::path::Prefix;
    match path.components().next() {
        Some(Component::Prefix(prefix)) => {
            matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
        }
        _ => false,
    }
}

#[cfg(not(windows))]
fn is_drive_path(_path: &Path) -> bool {
    true
}

fn mime_type(path: &Path) -> &'static str {
    let is_apng = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("apng"));
    if is_apng { "image/apng" } else { "image/png" }
}

#[cfg(test)]
mod tests {
    use super::{build_response, read_thumbnail};
    use crate::testutil::{TempDirGuard, create_ghost_dir_with_descript};
    use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
    use std::fs;
    use std::path::Path;
    use tauri::http::{StatusCode, Uri};

    /// encodeURIComponent が符号化しない文字（英数字と `-_.!~*'()`）を除いた集合。
    const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');

    /// フロントエンドの convertFileSrc（encodeURIComponent）と同じく符号化した URL を、
    /// http::Uri として解析し直したパス部（プロトコルの入口が受け取る `request.uri().path()`）。
    fn request_path(path: &Path) -> String {
        let url = format!(
            "http://thumbnail.localhost/{}",
            utf8_percent_encode(&path.to_string_lossy(), URI_COMPONENT)
        );
        url.parse::<Uri>().unwrap().path().to_string()
    }

    /// `{base}/{name}` にゴーストを作り、そのディレクトリを返す。
    fn ghost(base: &Path, name: &str) -> std::path::PathBuf {
        create_ghost_dir_with_descript(base, name, "name,A\ncharset,UTF-8\n").unwrap();
        base.join(name)
    }

    #[test]
    fn ゴーストのサムネイルは中身とpngの型で返す() {
        let tmp = TempDirGuard::new("thumbnail_protocol_ok");
        let root = ghost(tmp.path(), "g");
        fs::write(root.join("thumbnail.png"), b"png-bytes").unwrap();

        let (bytes, mime) = read_thumbnail(&request_path(&root.join("thumbnail.png"))).unwrap();
        assert_eq!(bytes, b"png-bytes");
        assert_eq!(mime, "image/png");
    }

    #[test]
    fn surface0のapngはapngの型で返す() {
        let tmp = TempDirGuard::new("thumbnail_protocol_apng");
        let root = ghost(tmp.path(), "g");
        let master = root.join("shell").join("master");
        fs::create_dir_all(&master).unwrap();
        fs::write(master.join("surface0.apng"), b"apng").unwrap();

        let (_, mime) = read_thumbnail(&request_path(&master.join("surface0.apng"))).unwrap();
        assert_eq!(mime, "image/apng");
    }

    #[test]
    fn 日本語や記号を含むパスも符号化を戻して読める() {
        let tmp = TempDirGuard::new("thumbnail_protocol_japanese");
        // URL で意味を持つ記号（% # + & = ;。? は Windows のファイル名に使えない）・空白・全角・絵文字・NFD（か＋濁点）を含む名前
        for name in [
            "さくら（全角）",
            "a%41 #+&=;",
            "🎉ゴースト",
            "\u{304B}\u{3099}",
        ] {
            let root = ghost(tmp.path(), name);
            fs::write(root.join("thumbnail.png"), name.as_bytes()).unwrap();

            let (bytes, _) = read_thumbnail(&request_path(&root.join("thumbnail.png")))
                .unwrap_or_else(|status| panic!("{name}: {status}"));
            assert_eq!(bytes, name.as_bytes(), "{name}");
        }
    }

    #[test]
    fn ゴースト構造の外の画像は404() {
        let tmp = TempDirGuard::new("thumbnail_protocol_outside");
        fs::write(tmp.path().join("secret.png"), b"secret").unwrap();
        // ゴーストのディレクトリでない場所の thumbnail.png も同じ
        fs::write(tmp.path().join("thumbnail.png"), b"secret").unwrap();

        for path in [
            tmp.path().join("secret.png"),
            tmp.path().join("thumbnail.png"),
        ] {
            assert_eq!(
                read_thumbnail(&request_path(&path)),
                Err(StatusCode::NOT_FOUND)
            );
        }
    }

    #[test]
    fn 親ディレクトリへの移動を含むパスは404() {
        // 形だけ見ると候補（g/../g/thumbnail.png）でも、.. を含むパスは受けない
        let tmp = TempDirGuard::new("thumbnail_protocol_parent_dir");
        let root = ghost(tmp.path(), "g");
        fs::write(root.join("thumbnail.png"), b"png").unwrap();
        let traversal = root.join("..").join("g").join("thumbnail.png");

        assert_eq!(
            read_thumbnail(&request_path(&traversal)),
            Err(StatusCode::NOT_FOUND)
        );
    }

    #[test]
    fn 相対パスは404() {
        assert_eq!(
            read_thumbnail(&request_path(Path::new("g/thumbnail.png"))),
            Err(StatusCode::NOT_FOUND)
        );
    }

    #[cfg(windows)]
    #[test]
    fn uncパスは404() {
        assert_eq!(
            read_thumbnail(&request_path(Path::new(r"\\server\share\g\thumbnail.png"))),
            Err(StatusCode::NOT_FOUND)
        );
    }

    #[test]
    fn utf8として不正な符号化は404() {
        assert_eq!(read_thumbnail("/%FF%FE"), Err(StatusCode::NOT_FOUND));
    }

    #[test]
    fn 上限を超える大きさの画像は404() {
        let tmp = TempDirGuard::new("thumbnail_protocol_too_large");
        let root = ghost(tmp.path(), "g");
        let file = fs::File::create(root.join("thumbnail.png")).unwrap();
        file.set_len(super::MAX_THUMBNAIL_BYTES + 1).unwrap();

        assert_eq!(
            read_thumbnail(&request_path(&root.join("thumbnail.png"))),
            Err(StatusCode::NOT_FOUND)
        );
    }

    #[test]
    fn 候補の形でもファイルが無ければ同じ404() {
        let tmp = TempDirGuard::new("thumbnail_protocol_missing");
        let root = ghost(tmp.path(), "g");

        assert_eq!(
            read_thumbnail(&request_path(&root.join("thumbnail.png"))),
            Err(StatusCode::NOT_FOUND)
        );
    }

    #[test]
    fn プロトコル名はcspとフロントエンドの定義と一致する() {
        // 名前がずれると、CSP で画像が弾かれるか、フロントが存在しないプロトコルを指す
        let manifest = env!("CARGO_MANIFEST_DIR");
        let conf = fs::read_to_string(Path::new(manifest).join("tauri.conf.json")).unwrap();
        let conf: serde_json::Value = serde_json::from_str(&conf).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();
        let img_src = csp
            .split(';')
            .map(str::trim)
            .find(|directive| directive.starts_with("img-src"))
            .unwrap();
        assert!(
            img_src.contains(&format!(" {}:", super::SCHEME)),
            "{img_src}"
        );
        assert!(
            img_src.contains(&format!("http://{}.localhost", super::SCHEME)),
            "{img_src}"
        );

        let front =
            fs::read_to_string(Path::new(manifest).join("../src/lib/thumbnailUrl.ts")).unwrap();
        assert!(
            front.contains(&format!("THUMBNAIL_SCHEME = \"{}\"", super::SCHEME)),
            "src/lib/thumbnailUrl.ts の THUMBNAIL_SCHEME がずれている"
        );
    }

    #[test]
    fn 応答には要求元のoriginだけを許可する() {
        let response = build_response("/%FF", Some("http://tauri.localhost"));
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.headers()["Access-Control-Allow-Origin"],
            "http://tauri.localhost"
        );
    }
}
