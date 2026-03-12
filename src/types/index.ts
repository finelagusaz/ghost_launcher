// IPC 型（Rust の struct から ts-rs で自動生成）
export type { Ghost } from "./generated/Ghost";
export type { ScanGhostsResponse } from "./generated/ScanGhostsResponse";

// TS 専用型（フロントエンド固有）

export type ThumbnailKind = "surface" | "thumbnail" | "";

/** DB クエリ結果。_lower カラムを含み、diff_fingerprint は SELECT 対象外 */
export interface GhostView {
  name: string;
  sakura_name: string;
  kero_name: string;
  craftman: string;
  craftmanw: string;
  directory_name: string;
  path: string;
  source: string;
  thumbnail_path: string;
  thumbnail_use_self_alpha: boolean;
  thumbnail_kind: ThumbnailKind;
  name_lower: string;
  sakura_name_lower: string;
  kero_name_lower: string;
  craftman_lower: string;
  craftmanw_lower: string;
  directory_name_lower: string;
}
