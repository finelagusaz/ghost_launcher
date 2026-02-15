import { useState, useEffect, useCallback, useRef } from "react";
import {
  readGhostCacheEntry,
  writeGhostCacheEntry,
} from "../lib/ghostCacheRepository";
import { getGhostsFingerprint, scanGhostsWithMeta } from "../lib/ghostScanClient";
import {
  buildAdditionalFolders,
  buildRequestKey,
  buildScanErrorMessage,
} from "../lib/ghostScanUtils";
import type {
  Ghost,
  GhostCacheEntry,
  GhostView,
  ScanGhostsResponse,
} from "../types";

const pendingScans = new Map<string, Promise<ScanGhostsResponse>>();
const SCAN_RETRY_ACTION_LABEL = "再読込";

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

  const refresh = useCallback(async (options: RefreshOptions = {}) => {
    if (!sspPath) {
      setGhosts([]);
      setError(null);
      setLoading(false);
      return;
    }

    const additionalFolders = buildAdditionalFolders(ghostFolders);
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

      if (!forceFullScan && cachedEntry) {
        try {
          const fingerprint = await getGhostsFingerprint(sspPath, additionalFolders);
          if (requestSeq !== requestSeqRef.current) {
            return;
          }

          if (fingerprint === cachedEntry.fingerprint) {
            return;
          }
        } catch {
          // 指紋取得に失敗した場合はフルスキャンへフォールバックする。
        }
      }

      let scanPromise = pendingScans.get(requestKey);
      if (!scanPromise || forceFullScan) {
        scanPromise = scanGhostsWithMeta(sspPath, additionalFolders);
        pendingScans.set(requestKey, scanPromise);
        scanPromise.finally(() => {
          if (pendingScans.get(requestKey) === scanPromise) {
            pendingScans.delete(requestKey);
          }
        });
      }

      const result = await scanPromise;
      if (requestSeq === requestSeqRef.current) {
        setGhosts(result.ghosts.map(toGhostView));
        setError(null);
      }

      await writeGhostCacheEntry(requestKey, {
        request_key: requestKey,
        fingerprint: result.fingerprint,
        ghosts: result.ghosts,
        cached_at: new Date().toISOString(),
      });
    } catch (e) {
      if (requestSeq === requestSeqRef.current) {
        if (!usedCachedGhosts || forceFullScan) {
          const scanErrorMessage = buildScanErrorMessage(e);
          const actionableMessage = scanErrorMessage.includes(SCAN_RETRY_ACTION_LABEL)
            ? scanErrorMessage
            : `${scanErrorMessage}「${SCAN_RETRY_ACTION_LABEL}」を実行してください。`;
          setError(actionableMessage);
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
  }, [sspPath, ghostFolders]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ghosts, loading, error, refresh };
}
