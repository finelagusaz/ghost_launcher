import { cleanupOldGhostCaches, getCachedFingerprint, hasGhosts, replaceGhostsByRequestKey, setCachedFingerprint } from "./ghostDatabase";
import { executeScan } from "./ghostScanOrchestrator";
import { buildAdditionalFolders, buildRequestKey } from "./ghostScanUtils";

// localStorage に残った旧 fingerprint キーの掃除（v0.x → v1.0 移行）
for (let i = localStorage.length - 1; i >= 0; i--) {
  const key = localStorage.key(i);
  if (key?.startsWith("fingerprint_")) localStorage.removeItem(key);
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
  // これにより cacheHit=true 時は dbHasData=true が論理的に保証され、
  // replaceGhostsByRequestKey([]) による意図しない全削除を構造的に防ぐ。
  const dbHasData = forceFullScan ? false : await hasGhosts(requestKey);
  const cachedFingerprint = (forceFullScan || !dbHasData) ? null : await getCachedFingerprint(requestKey);
  const result = await executeScan({
    requestKey,
    sspPath,
    additionalFolders,
    forceFullScan,
    cachedFingerprint,
  });

  if (result.cacheHit) {
    return { skipped: true };
  }

  await replaceGhostsByRequestKey(requestKey, result.ghosts);
  await setCachedFingerprint(requestKey, result.fingerprint);

  try {
    await cleanupOldGhostCaches(requestKey);
  } catch (error) {
    console.warn("[ghostCatalogService] キャッシュ寿命管理のクリーンアップに失敗しました", error);
  }

  return { skipped: false };
}
