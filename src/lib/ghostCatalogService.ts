import { invoke } from "@tauri-apps/api/core";
import { cleanupOldGhostCaches, getCachedFingerprint, hasGhosts } from "./ghostDatabase";
import { buildAdditionalFolders, buildRequestKey } from "./ghostScanUtils";

interface ScanStoreResult {
  cache_hit: boolean;
  total: number;
  fingerprint: string;
  request_key: string;
}

export interface RefreshGhostCatalogParams {
  sspPath: string;
  ghostFolders: string[];
  forceFullScan: boolean;
}

export interface RefreshGhostCatalogResult {
  skipped: boolean;
}

export async function refreshGhostCatalog({
  sspPath,
  ghostFolders,
  forceFullScan,
}: RefreshGhostCatalogParams): Promise<RefreshGhostCatalogResult> {
  const additionalFolders = buildAdditionalFolders(ghostFolders);
  const requestKey = buildRequestKey(sspPath, additionalFolders);

  // DB が空なら fingerprint を送らない → Rust は必ずフルスキャン結果を返す。
  // これにより cache_hit=true 時は dbHasData=true が論理的に保証される。
  let cachedFingerprint: string | null = null;
  if (!forceFullScan) {
    const [dbHasData, fp] = await Promise.all([hasGhosts(requestKey), getCachedFingerprint(requestKey)]);
    cachedFingerprint = dbHasData ? fp : null;
  }

  // Rust が scan + DB 書き込み + fingerprint 保存を一括で行う。
  // Ghost 配列は IPC を横断しない。
  const result = await invoke<ScanStoreResult>("scan_and_store", {
    sspPath,
    additionalFolders,
    cachedFingerprint,
  });

  if (result.cache_hit) {
    return { skipped: true };
  }

  // 寿命管理は JS 側で fire-and-forget（失敗許容）
  void cleanupOldGhostCaches(result.request_key).catch((error) => {
    console.warn("[ghostCatalogService] キャッシュ寿命管理のクリーンアップに失敗しました", error);
  });

  return { skipped: false };
}
