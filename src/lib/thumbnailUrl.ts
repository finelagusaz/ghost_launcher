import { convertFileSrc } from "@tauri-apps/api/core";

/// サムネイル用の読み取りプロトコル名（src-tauri/src/thumbnail_protocol.rs の SCHEME と同じ値）。
/// Rust 側はゴーストのサムネイルとして成り立つ形のパスだけを返す。
export const THUMBNAIL_SCHEME = "thumbnail";

/// サムネイル画像のファイルパスを、webview から読める URL にする。
export function thumbnailUrl(path: string): string {
  return convertFileSrc(path, THUMBNAIL_SCHEME);
}
