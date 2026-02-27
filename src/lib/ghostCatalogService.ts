import { hasGhosts, replaceGhostsByRequestKey } from "./ghostDatabase";
import { getCachedFingerprint, setCachedFingerprint } from "./fingerprintCache";
import { executeScan, validateCache } from "./ghostScanOrchestrator";
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

  if (!forceFullScan) {
    const cachedFingerprint = getCachedFingerprint(requestKey);
    if (cachedFingerprint) {
      const exists = await hasGhosts(requestKey);
      if (exists) {
        const cacheValid = await validateCache(cachedFingerprint, sspPath, additionalFolders);
        if (cacheValid) {
          return { skipped: true };
        }
      }
    }
  }

  const result = await executeScan(requestKey, sspPath, additionalFolders, forceFullScan);
  await replaceGhostsByRequestKey(requestKey, result.ghosts);
  setCachedFingerprint(requestKey, result.fingerprint);
  return { skipped: false };
}
