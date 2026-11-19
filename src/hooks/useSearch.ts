import { useState, useEffect, useRef } from "react";
import type { GhostView, SortOrder } from "../types";
import { countGhostsByQuery, searchGhosts, searchGhostsInitialPage } from "../lib/ghostDatabase";

// バッファの最大サイズ。これを超えるマージは全置換にフォールバックする
export const MAX_BUFFER_SIZE = 2000;

// 行の浅い等値判定。DB 行は SELECT 列だけを持つフラットなプリミティブの集まりなので
// 浅い比較で内容一致を判定できる。path だけで同一視しないのは、refreshTrigger 前に
// スキャンが DB を書き換えた隙間のページ取得で、古いフィールドを固定しないため。
// キー数の一致を前提にするので、マージ対象の両側（searchGhostsInitialPage / searchGhosts）は
// 同じ射影（GHOST_SELECT_COLUMNS_PREFIXED）を保つこと。片側だけ列が増えると全行が
// 不一致になり、参照保持が黙って無効化される
function isSameRow(a: GhostView, b: GhostView): boolean {
  if (a === b) return true;
  const keys = Object.keys(a) as (keyof GhostView)[];
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

export function useSearch(
  requestKey: string | null,
  query: string,
  limit: number,
  offset: number,
  refreshTrigger: number,
  sortOrder: SortOrder = "name",
  // 同じ sortOrder のまま並び順が変わったことを可視化する epoch（ランダムの再選択による
  // シード変更、最近起動順・起動回数順での起動記録）。resetKey/deps に含めることで、
  // モジュールスコープの状態や DB の集計列の更新だけでは検知できない並びの変化でも
  // 取り直しを強制し、旧い並びのバッファが新しい並びのページと縫合されるのを防ぐ
  sortEpoch: number = 0,
): { ghosts: GhostView[]; total: number; loadedStart: number; loading: boolean; dbError: string | null } {
  const [ghosts, setGhosts] = useState<GhostView[]>([]);
  const [total, setTotal] = useState(0);
  const [loadedStart, setLoadedStart] = useState(0);
  const [loading, setLoading] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);

  // バッファマージ用: setGhosts 外からバッファ状態を参照するための ref
  const bufferRef = useRef({ ghosts: [] as GhostView[], start: 0 });
  // コンテキスト変更（query/requestKey/refreshTrigger/sortOrder/sortEpoch）検知用
  const resetKeyRef = useRef("");
  // 直前に取得したときのコンテキストのうち、並び順の epoch を除いた部分
  const contextKeyRef = useRef("");
  // total を確定させた COUNT のキー。総数は requestKey/query/refreshTrigger だけで決まり、
  // 並び替えでは変わらないため、同じキーなら COUNT を再発行せず total を保つ
  const countedKeyRef = useRef("");

  useEffect(() => {
    let isActive = true;
    const countKey = `${requestKey}\0${query}\0${refreshTrigger}`;
    const contextKey = `${countKey}\0${sortOrder}`;
    const resetKey = `${contextKey}\0${sortEpoch}`;
    const isReset = resetKey !== resetKeyRef.current;
    const needsCount = countKey !== countedKeyRef.current;
    // epoch だけが進んだ（同じ集合・同じソートのまま並び順が変わった）
    const isReorderOnly =
      isReset && contextKey === contextKeyRef.current && bufferRef.current.ghosts.length > 0;

    // COUNT の結果を total に反映したときだけ「数え済み」にする。発行時に印を付けると、
    // 再実行で結果が捨てられたとき total が暫定値のまま固まる
    function applyCount(count: number) {
      setTotal(count);
      countedKeyRef.current = countKey;
    }

    function commitKeys() {
      resetKeyRef.current = resetKey;
      contextKeyRef.current = contextKey;
    }

    async function fetchGhosts() {
      if (!requestKey) {
        setGhosts([]);
        setTotal(0);
        setLoadedStart(0);
        setDbError(null);
        setLoading(false);
        bufferRef.current = { ghosts: [], start: 0 };
        resetKeyRef.current = "";
        contextKeyRef.current = "";
        countedKeyRef.current = "";
        return;
      }

      setLoading(true);
      setDbError(null);
      try {
        if (isReorderOnly) {
          // 並びだけの更新: 表示中のバッファの範囲をそのまま取り直す。offset の窓で取り直すと、
          // 先読みで広がったバッファのうち表示中の行が窓の外に落ち、いったん Skeleton になる
          const prev = bufferRef.current;
          const [pageGhosts, newTotal] = await Promise.all([
            searchGhosts(requestKey, query, prev.ghosts.length, prev.start, sortOrder),
            needsCount ? countGhostsByQuery(requestKey, query) : Promise.resolve(null),
          ]);
          if (!isActive) return;

          commitKeys();
          // 並びが変わっても行の内容は同じことが多いので、path で引いて内容が等しい行は
          // 既存の参照を保ち、memo 化された GhostCard の再描画を避ける
          const byPath = new Map(prev.ghosts.map((g) => [g.path, g]));
          const next = pageGhosts.map((incoming) => {
            const existing = byPath.get(incoming.path);
            return existing && isSameRow(existing, incoming) ? existing : incoming;
          });
          setGhosts(next);
          setLoadedStart(prev.start);
          bufferRef.current = { ghosts: next, start: prev.start };
          if (newTotal !== null) applyCount(newTotal);
          return;
        }

        // 初期ロード（全置換 + 暫定 total + COUNT の遅延取得）はリセット時だけ。
        // スクロールで先頭へ戻っただけの offset 0 は下のマージ経路に流し、
        // total の巻き戻りと COUNT の再発行を避ける
        const isInitialLoad = isReset && query === "" && offset === 0;

        if (isInitialLoad) {
          const initialGhosts = await searchGhostsInitialPage(requestKey, limit, sortOrder);
          if (!isActive) return;

          commitKeys();
          setGhosts(initialGhosts);
          setLoadedStart(0);
          bufferRef.current = { ghosts: initialGhosts, start: 0 };

          // 初期描画を優先して総件数は遅延取得する。ソートの切替など総数が変わらない
          // リセットでは、暫定値へ巻き戻さず COUNT も発行しない
          if (needsCount) {
            setTotal(initialGhosts.length);
            void countGhostsByQuery(requestKey, query)
              .then((count) => {
                if (!isActive) return;
                applyCount(count);
              })
              .catch((err) => {
                console.warn("Failed to count ghosts from SQLite:", err);
              });
          }

          return;
        }

        // COUNT は総数が変わり得るリセット時のみ発行する（スクロールのページ送りや
        // 並び替えで再発行しない）。SELECT と並行して待ち時間を重ねない
        const [pageGhosts, newTotal] = await Promise.all([
          searchGhosts(requestKey, query, limit, offset, sortOrder),
          isReset && needsCount ? countGhostsByQuery(requestKey, query) : Promise.resolve(null),
        ]);
        if (!isActive) return;

        commitKeys();

        if (isReset) {
          // コンテキスト変更 → バッファクリアして全置換
          setGhosts(pageGhosts);
          setLoadedStart(offset);
          bufferRef.current = { ghosts: pageGhosts, start: offset };
          if (newTotal !== null) applyCount(newTotal);
        } else {
          // スクロールによる offset 変更 → マージ（total はリセット時の値を保持）
          const prev = bufferRef.current;
          const prevEnd = prev.start + prev.ghosts.length;
          const newEnd = offset + pageGhosts.length;
          const hasOverlap = offset <= prevEnd && newEnd >= prev.start;
          const mergedStart = Math.min(prev.start, offset);
          const mergedEnd = Math.max(prevEnd, newEnd);

          if (!hasOverlap || mergedEnd - mergedStart > MAX_BUFFER_SIZE) {
            // ギャップあり or バッファ上限超過 → 全置換
            setGhosts(pageGhosts);
            setLoadedStart(offset);
            bufferRef.current = { ghosts: pageGhosts, start: offset };
          } else {
            // 隣接/重複 → マージ
            const merged = new Array<GhostView>(mergedEnd - mergedStart);
            for (let i = 0; i < prev.ghosts.length; i++) {
              merged[prev.start - mergedStart + i] = prev.ghosts[i];
            }
            // 先読みページは表示中の行を含むため、内容が等しい行は既存の参照を保ち、
            // memo 化された GhostCard の可視行全再描画を避ける
            for (let i = 0; i < pageGhosts.length; i++) {
              const idx = offset - mergedStart + i;
              const existing = merged[idx];
              const incoming = pageGhosts[i];
              merged[idx] = existing && isSameRow(existing, incoming) ? existing : incoming;
            }
            setGhosts(merged);
            setLoadedStart(mergedStart);
            bufferRef.current = { ghosts: merged, start: mergedStart };
          }
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
  }, [requestKey, query, limit, offset, refreshTrigger, sortOrder, sortEpoch]);

  return { ghosts, total, loadedStart, loading, dbError };
}
