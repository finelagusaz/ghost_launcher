import { cleanupOldGhostCaches, getCachedFingerprint, hasGhosts, replaceGhostsByRequestKey, setCachedFingerprint } from "./ghostDatabase";
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
  let cachedFingerprint: string | null = null;
  if (!forceFullScan) {
    const [dbHasData, fp] = await Promise.all([hasGhosts(requestKey), getCachedFingerprint(requestKey)]);
    cachedFingerprint = dbHasData ? fp : null;
  }
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

  // fingerprint 保存と寿命管理は互いに独立。どちらも失敗してよい（次回フルスキャンで復旧）
  await Promise.all([
    setCachedFingerprint(requestKey, result.fingerprint).catch((error) => {
      console.warn("[ghostCatalogService] fingerprint の保存に失敗しました", error);
    }),
    cleanupOldGhostCaches(requestKey).catch((error) => {
      console.warn("[ghostCatalogService] キャッシュ寿命管理のクリーンアップに失敗しました", error);
    }),
  ]);

  return { skipped: false };
}
