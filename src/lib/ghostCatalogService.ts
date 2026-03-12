import { cleanupOldGhostCaches, hasGhosts, replaceGhostsByRequestKey } from "./ghostDatabase";
import { getCachedFingerprint, pruneFingerprintCache, setCachedFingerprint } from "./fingerprintCache";
import { executeScan } from "./ghostScanOrchestrator";
import { buildAdditionalFolders, buildRequestKey } from "./ghostScanUtils";

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
  const cachedFingerprint = (forceFullScan || !dbHasData) ? null : getCachedFingerprint(requestKey);
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
  setCachedFingerprint(requestKey, result.fingerprint);

  try {
    const keepRequestKeys = await cleanupOldGhostCaches(requestKey);
    pruneFingerprintCache(keepRequestKeys);
  } catch (error) {
    console.warn("[ghostCatalogService] キャッシュ寿命管理のクリーンアップに失敗しました", error);
  }

  return { skipped: false };
}
