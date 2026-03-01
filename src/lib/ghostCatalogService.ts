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

  const cachedFingerprint = forceFullScan ? null : getCachedFingerprint(requestKey);
  const result = await executeScan({
    requestKey,
    sspPath,
    additionalFolders,
    forceFullScan,
    cachedFingerprint,
  });

  const cacheFingerprintMatched =
    !forceFullScan &&
    cachedFingerprint !== null &&
    result.fingerprint === cachedFingerprint;

  if (cacheFingerprintMatched) {
    const exists = await hasGhosts(requestKey);
    if (exists) {
      return { skipped: true };
    }
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
