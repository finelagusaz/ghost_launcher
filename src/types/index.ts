export type ThumbnailKind = "surface" | "thumbnail" | "";

export interface Ghost {
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
  diff_fingerprint?: string;
}

export interface GhostView extends Ghost {
  name_lower: string;
  sakura_name_lower: string;
  kero_name_lower: string;
  craftman_lower: string;
  craftmanw_lower: string;
  directory_name_lower: string;
}

export interface ScanGhostsResponse {
  ghosts: Ghost[];
  fingerprint: string;
  cache_hit: boolean;
}

