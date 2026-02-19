import { useState, useEffect, useCallback, useRef } from "react";
import {
  readGhostCacheEntry,
  writeGhostCacheEntry,
} from "../lib/ghostCacheRepository";
import { validateCache, executeScan } from "../lib/ghostScanOrchestrator";
import {
  buildAdditionalFolders,
  buildRequestKey,
  buildScanErrorMessage,
} from "../lib/ghostScanUtils";
import type { Ghost, GhostCacheEntry, GhostView } from "../types";

interface RefreshOptions {
  forceFullScan?: boolean;
}

function toGhostView(ghost: Ghost): GhostView {
  return {
    ...ghost,
    name_lower: ghost.name.toLowerCase(),
    directory_name_lower: ghost.directory_name.toLowerCase(),
  };
}

export function useGhosts(sspPath: string | null, ghostFolders: string[]) {
  const [ghosts, setGhosts] = useState<GhostView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightKeyRef = useRef<string | null>(null);
  const requestSeqRef = useRef(0);

  // ghostFolders の参照安定化: 内容が同じなら useCallback を再生成しない
  const ghostFoldersKey = JSON.stringify(ghostFolders);
  const ghostFoldersRef = useRef(ghostFolders);
  ghostFoldersRef.current = ghostFolders;

  const refresh = useCallback(async (options: RefreshOptions = {}) => {
    if (!sspPath) {
      setGhosts([]);
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
    let cachedEntry: GhostCacheEntry | undefined;

    try {
      setError(null);

      // 1. キャッシュ表示
      if (!forceFullScan) {
        cachedEntry = await readGhostCacheEntry(requestKey);

        if (requestSeq !== requestSeqRef.current) {
          return;
        }

        if (cachedEntry) {
          usedCachedGhosts = true;
          setGhosts(cachedEntry.ghosts.map(toGhostView));
        }
      }

      setLoading(!usedCachedGhosts);

      // 2. 指紋検証
      if (!forceFullScan && cachedEntry) {
        const cacheValid = await validateCache(cachedEntry, sspPath, additionalFolders);
        if (requestSeq !== requestSeqRef.current) {
          return;
        }
        if (cacheValid) {
          return;
        }
      }

      // 3. スキャン実行
      const result = await executeScan(requestKey, sspPath, additionalFolders, forceFullScan);
      if (requestSeq === requestSeqRef.current) {
        setGhosts(result.ghosts.map(toGhostView));
        setError(null);
      }

      // 4. キャッシュ書き込み
      await writeGhostCacheEntry(requestKey, {
        request_key: requestKey,
        fingerprint: result.fingerprint,
        ghosts: result.ghosts,
        cached_at: new Date().toISOString(),
      });
    } catch (e) {
      if (requestSeq === requestSeqRef.current) {
        if (!usedCachedGhosts || forceFullScan) {
          setError(buildScanErrorMessage(e));
          setGhosts([]);
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

  return { ghosts, loading, error, refresh };
}
