import { useState, useEffect, useCallback, useRef } from "react";
import { validateCache, executeScan } from "../lib/ghostScanOrchestrator";
import {
  buildAdditionalFolders,
  buildRequestKey,
  buildScanErrorMessage,
} from "../lib/ghostScanUtils";


interface RefreshOptions {
  forceFullScan?: boolean;
}

export function useGhosts(sspPath: string | null, ghostFolders: string[]) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlightKeyRef = useRef<string | null>(null);
  const requestSeqRef = useRef(0);

  // ghostFolders の参照安定化: 内容が同じなら useCallback を再生成しない
  const ghostFoldersKey = JSON.stringify(ghostFolders);
  const ghostFoldersRef = useRef(ghostFolders);
  ghostFoldersRef.current = ghostFolders;

  const refresh = useCallback(async (options: RefreshOptions = {}) => {
    if (!sspPath) {
      setError(null);
      setLoading(false);
      return;
    }

    const additionalFolders = buildAdditionalFolders(ghostFoldersRef.current);
    const requestKey = buildRequestKey(sspPath, additionalFolders);
    const forceFullScan = options.forceFullScan === true;
    const inFlightKey = `${requestKey}::${forceFullScan ? "force" : "auto"}`;

    if (inFlightKeyRef.current === inFlightKey) {
      return;
    }

    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    inFlightKeyRef.current = inFlightKey;

    let usedCachedGhosts = false;

    try {
      setError(null);
      setLoading(true);

      const cachedFingerprint = localStorage.getItem(`fingerprint_${requestKey}`);

      if (!forceFullScan && cachedFingerprint) {
        // Check if SQLite has any rows
        const { searchGhosts } = await import("../lib/ghostDatabase");
        try {
          const initResult = await searchGhosts(requestKey, "", 1, 0);
          if (initResult.total > 0) {
            const cacheValid = await validateCache(cachedFingerprint, sspPath, additionalFolders);
            if (requestSeq !== requestSeqRef.current) return;
            if (cacheValid) {
              usedCachedGhosts = true;
              return; // We're done! App.tsx's `useSearch` will fetch the list from SQLite
            }
          }
        } catch (dbError) {
          console.error("SQLite check failed during cache validation", dbError);
        }
      }

      // スキャン実行
      const result = await executeScan(requestKey, sspPath, additionalFolders, forceFullScan);
      
      // SQLite に保存（失敗時は fingerprint を更新しない）
      const { replaceGhostsByRequestKey } = await import("../lib/ghostDatabase");
      try {
        await replaceGhostsByRequestKey(requestKey, result.ghosts);
      } catch (dbError) {
        console.error("Failed to populate SQLite database:", dbError);
        throw new Error("SQLiteへの保存に失敗しました");
      }

      // 指紋を記録して次回スキップできるようにする（DB保存成功時のみ）
      localStorage.setItem(`fingerprint_${requestKey}`, result.fingerprint);

      if (requestSeq === requestSeqRef.current) {
        setError(null);
      }

    } catch (e) {
      if (requestSeq === requestSeqRef.current) {
        if (!usedCachedGhosts || forceFullScan) {
          setError(buildScanErrorMessage(e));
        }
      }
    } finally {
      if (requestSeq === requestSeqRef.current) {
        setLoading(false);
      }
      if (inFlightKeyRef.current === inFlightKey) {
        inFlightKeyRef.current = null;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sspPath, ghostFoldersKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { loading, error, refresh };
}
