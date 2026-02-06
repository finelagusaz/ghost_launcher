import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Ghost } from "../types";

export function useGhosts(sspPath: string | null, ghostFolders: string[]) {
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sspPath) {
      setGhosts([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<Ghost[]>("scan_ghosts", {
        sspPath,
        additionalFolders: ghostFolders,
      });
      setGhosts(result);
    } catch (e) {
      setError(String(e));
      setGhosts([]);
    } finally {
      setLoading(false);
    }
  }, [sspPath, ghostFolders]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ghosts, loading, error, refresh };
}
