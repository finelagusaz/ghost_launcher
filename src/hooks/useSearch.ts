import { useMemo } from "react";
import type { Ghost } from "../types";

export function useSearch(ghosts: Ghost[], query: string): Ghost[] {
  return useMemo(() => {
    if (!query.trim()) return ghosts;
    const lowerQuery = query.toLowerCase();
    return ghosts.filter(
      (g) =>
        g.name.toLowerCase().includes(lowerQuery) ||
        g.directory_name.toLowerCase().includes(lowerQuery)
    );
  }, [ghosts, query]);
}
