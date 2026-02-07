import { useMemo } from "react";
import type { GhostView } from "../types";

export function useSearch(ghosts: GhostView[], query: string): GhostView[] {
  return useMemo(() => {
    if (!query.trim()) return ghosts;
    const lowerQuery = query.toLowerCase();
    return ghosts.filter(
      (g) => g.name_lower.includes(lowerQuery) || g.directory_name_lower.includes(lowerQuery)
    );
  }, [ghosts, query]);
}
