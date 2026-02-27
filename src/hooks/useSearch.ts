import { useState, useEffect } from "react";
import type { GhostView } from "../types";
import { searchGhosts } from "../lib/ghostDatabase";

export function useSearch(
  requestKey: string | null,
  query: string,
  limit: number,
  offset: number,
  refreshTrigger: number
): { ghosts: GhostView[]; total: number; loadedStart: number; loading: boolean; dbError: string | null } {
  const [ghosts, setGhosts] = useState<GhostView[]>([]);
  const [total, setTotal] = useState(0);
  const [loadedStart, setLoadedStart] = useState(0);
  const [loading, setLoading] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;

    async function fetchGhosts() {
      if (!requestKey) {
        setGhosts([]);
        setTotal(0);
        setLoadedStart(0);
        setDbError(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setDbError(null);
      try {
        const result = await searchGhosts(requestKey, query, limit, offset);
        if (isActive) {
          setGhosts(result.ghosts);
          setTotal(result.total);
          setLoadedStart(offset);
        }
      } catch (err) {
        console.error("Failed to search ghosts from SQLite:", err);
        if (isActive) {
          setDbError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    }

    fetchGhosts();

    return () => {
      isActive = false;
    };
  }, [requestKey, query, limit, offset, refreshTrigger]);

  return { ghosts, total, loadedStart, loading, dbError };
}
