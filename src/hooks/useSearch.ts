import { useState, useEffect, useRef } from "react";
import type { GhostView } from "../types";
import { searchGhosts } from "../lib/ghostDatabase";

// バッファの最大サイズ。これを超えるマージは全置換にフォールバックする
export const MAX_BUFFER_SIZE = 2000;

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

  // バッファマージ用: setGhosts 外からバッファ状態を参照するための ref
  const bufferRef = useRef({ ghosts: [] as GhostView[], start: 0 });
  // コンテキスト変更（query/requestKey/refreshTrigger）検知用
  const resetKeyRef = useRef("");

  useEffect(() => {
    let isActive = true;
    const resetKey = `${requestKey}\0${query}\0${refreshTrigger}`;
    const isReset = resetKey !== resetKeyRef.current;

    async function fetchGhosts() {
      if (!requestKey) {
        setGhosts([]);
        setTotal(0);
        setLoadedStart(0);
        setDbError(null);
        setLoading(false);
        bufferRef.current = { ghosts: [], start: 0 };
        resetKeyRef.current = "";
        return;
      }

      setLoading(true);
      setDbError(null);
      try {
        const result = await searchGhosts(requestKey, query, limit, offset);
        if (!isActive) return;

        resetKeyRef.current = resetKey;

        if (isReset) {
          // コンテキスト変更 → バッファクリアして全置換
          setGhosts(result.ghosts);
          setLoadedStart(offset);
          bufferRef.current = { ghosts: result.ghosts, start: offset };
        } else {
          // スクロールによる offset 変更 → マージ
          const prev = bufferRef.current;
          const prevEnd = prev.start + prev.ghosts.length;
          const newEnd = offset + result.ghosts.length;
          const hasOverlap = offset <= prevEnd && newEnd >= prev.start;
          const mergedStart = Math.min(prev.start, offset);
          const mergedEnd = Math.max(prevEnd, newEnd);

          if (!hasOverlap || mergedEnd - mergedStart > MAX_BUFFER_SIZE) {
            // ギャップあり or バッファ上限超過 → 全置換
            setGhosts(result.ghosts);
            setLoadedStart(offset);
            bufferRef.current = { ghosts: result.ghosts, start: offset };
          } else {
            // 隣接/重複 → マージ
            const merged = new Array<GhostView>(mergedEnd - mergedStart);
            for (let i = 0; i < prev.ghosts.length; i++) {
              merged[prev.start - mergedStart + i] = prev.ghosts[i];
            }
            for (let i = 0; i < result.ghosts.length; i++) {
              merged[offset - mergedStart + i] = result.ghosts[i];
            }
            setGhosts(merged);
            setLoadedStart(mergedStart);
            bufferRef.current = { ghosts: merged, start: mergedStart };
          }
        }
        setTotal(result.total);
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
