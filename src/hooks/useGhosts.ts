import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Ghost, GhostView } from "../types";

const pendingScans = new Map<string, Promise<Ghost[]>>();

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

  const refresh = useCallback(async () => {
    if (!sspPath) {
      setGhosts([]);
      return;
    }

    const requestKey = `${sspPath}::${ghostFolders.join("|")}`;
    if (inFlightKeyRef.current === requestKey) {
      return;
    }

    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    inFlightKeyRef.current = requestKey;

    setLoading(true);
    setError(null);
    try {
      let scanPromise = pendingScans.get(requestKey);
      if (!scanPromise) {
        scanPromise = invoke<Ghost[]>("scan_ghosts", {
          sspPath,
          additionalFolders: ghostFolders,
        }).finally(() => {
          pendingScans.delete(requestKey);
        });
        pendingScans.set(requestKey, scanPromise);
      }
      const result = await scanPromise;
      if (requestSeq === requestSeqRef.current) {
        setGhosts(result.map(toGhostView));
      }
    } catch (e) {
      if (requestSeq === requestSeqRef.current) {
        setError(String(e));
        setGhosts([]);
      }
    } finally {
      if (requestSeq === requestSeqRef.current) {
        setLoading(false);
      }
      if (inFlightKeyRef.current === requestKey) {
        inFlightKeyRef.current = null;
      }
    }
  }, [sspPath, ghostFolders]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ghosts, loading, error, refresh };
}
