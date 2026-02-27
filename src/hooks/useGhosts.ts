import { useState, useEffect, useCallback, useRef } from "react";
import { refreshGhostCatalog } from "../lib/ghostCatalogService";
import { buildAdditionalFolders, buildRequestKey, buildScanErrorMessage } from "../lib/ghostScanUtils";

interface RefreshOptions {
  forceFullScan?: boolean;
}

export function useGhosts(sspPath: string | null, ghostFolders: string[]) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
        setError(buildScanErrorMessage(e));
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
