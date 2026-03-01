export interface Ghost {
  name: string;
  craftman: string;
  directory_name: string;
  path: string;
  source: string;
  thumbnail_path: string;
  thumbnail_use_self_alpha: boolean;
  thumbnail_kind: string;
}

export interface GhostView extends Ghost {
  name_lower: string;
  directory_name_lower: string;
}

export interface ScanGhostsResponse {
  ghosts: Ghost[];
  fingerprint: string;
}

export interface GhostCacheEntry {
  request_key: string;
  fingerprint: string;
  ghosts: Ghost[];
  cached_at: string;
}

export interface GhostCacheStoreV1 {
  version: 1;
  entries: Record<string, GhostCacheEntry>;
}
