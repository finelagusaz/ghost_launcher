import { useState, useEffect, useCallback, useRef } from "react";
import { refreshGhostCatalog } from "../lib/ghostCatalogService";
import { requestKeyFromSettings } from "../lib/ghostScanUtils";

interface RefreshOptions {
  forceFullScan?: boolean;
}

/// スキャン失敗の生の値。文言は表示側が UI の言語で組み立てる（翻訳済みの文字列を持つと、
/// 言語を切り替えても前の言語の文言が残る）。reject 値が falsy でも「失敗あり」を表せるよう包む。
export interface ScanFailure {
  cause: unknown;
}

export function useGhosts(sspPath: string | null, ghostFolders: string[]) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ScanFailure | null>(null);
  const inFlightKeyRef = useRef<string | null>(null);
  const requestSeqRef = useRef(0);

  const ghostFoldersKey = JSON.stringify(ghostFolders);
  const ghostFoldersRef = useRef(ghostFolders);
  ghostFoldersRef.current = ghostFolders;

  const refresh = useCallback(async (options: RefreshOptions = {}) => {
    if (!sspPath) {
      setError(null);
      setLoading(false);
      return;
    }

    const requestKey = requestKeyFromSettings(sspPath, ghostFoldersRef.current);
    const forceFullScan = options.forceFullScan === true;
    const inFlightKey = `${requestKey}::${forceFullScan ? "force" : "auto"}`;

    if (inFlightKeyRef.current === inFlightKey) {
      return;
    }

    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    inFlightKeyRef.current = inFlightKey;

    try {
      setError(null);
      setLoading(true);

      await refreshGhostCatalog({
        sspPath,
        ghostFolders: ghostFoldersRef.current,
        forceFullScan,
      });

      if (requestSeq === requestSeqRef.current) {
        setError(null);
      }
    } catch (e) {
      if (requestSeq === requestSeqRef.current) {
        setError({ cause: e });
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
