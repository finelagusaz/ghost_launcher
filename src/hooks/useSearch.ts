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

// 並びの更新で取り直した行に、内容が等しい既存の行の参照を引き継ぐ（並びが変わると位置が
// ずれるため、path で引く）。memo 化された GhostCard の再描画を避けるためである。
// 全行が既存の参照のまま並びも変わらなければ、置き換え不要を null で返す
function reuseSameRows(prev: GhostView[], incoming: GhostView[]): GhostView[] | null {
  const byPath = new Map(prev.map((row) => [row.path, row]));
  const next = incoming.map((row) => {
    const existing = byPath.get(row.path);
    return existing && isSameRow(existing, row) ? existing : row;
  });
  const unchanged = next.length === prev.length && next.every((row, i) => row === prev[i]);
  return unchanged ? null : next;
}

export function useSearch(
  requestKey: string | null,
  query: string,
  limit: number,
  offset: number,
  refreshTrigger: number,
  sortOrder: SortOrder = "name",
  // 同じ sortOrder のまま並び順が変わったことを知らせる epoch。ランダムの再選択（シードの
  // 引き直し）と、最近起動順・起動回数順での起動記録（集計列の更新）で進む。どちらの変化も
  // effect の依存からは見えないため、epoch を依存に含めて取り直しを強制する。取り直さないと、
  // 古い並びのバッファが新しい並びのページと縫い合わされる
  sortEpoch: number = 0,
): { ghosts: GhostView[]; total: number; loadedStart: number; loading: boolean; dbError: string | null } {
  const [ghosts, setGhosts] = useState<GhostView[]>([]);
  const [total, setTotal] = useState(0);
  const [loadedStart, setLoadedStart] = useState(0);
  const [loading, setLoading] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);

  // バッファマージ用: setGhosts 外からバッファ状態を参照するための ref
  const bufferRef = useRef({ ghosts: [] as GhostView[], start: 0 });
  // 直前に取得を確定したときの前提。context は総数と並びを決める値（requestKey・query・
  // refreshTrigger・sortOrder）、epoch は並び順の epoch
  const committedRef = useRef<{ context: string; epoch: number } | null>(null);
  // total を確定させた COUNT のキー。総数は requestKey・query・refreshTrigger だけで決まり、
  // ソートの切替や並びの更新では変わらない。キーが同じなら COUNT を発行せず total を保つ
  const countedKeyRef = useRef("");

  useEffect(() => {
    let isActive = true;
    const countKey = `${requestKey}\0${query}\0${refreshTrigger}`;
    const contextKey = `${countKey}\0${sortOrder}`;
    const committed = committedRef.current;
    const isSameContext = committed !== null && committed.context === contextKey;
    const isReset = !isSameContext || committed.epoch !== sortEpoch;
    // 並びの更新: epoch だけが進んだ（同じ集合・同じソートのまま、並び順だけが変わった）
    const isReorderOnly =
      isSameContext && committed.epoch !== sortEpoch && bufferRef.current.ghosts.length > 0;
    const needsCount = countKey !== countedKeyRef.current;

    // COUNT の結果を total に反映した時点で「数え済み」にする。発行時に印を付けると、
    // effect の再実行で結果が捨てられたとき、total が暫定値のまま固まる
    function applyCount(count: number) {
      setTotal(count);
      countedKeyRef.current = countKey;
    }

    async function fetchGhosts() {
      if (!requestKey) {
        setGhosts([]);
        setTotal(0);
        setLoadedStart(0);
        setDbError(null);
        setLoading(false);
        bufferRef.current = { ghosts: [], start: 0 };
        committedRef.current = null;
        countedKeyRef.current = "";
        return;
      }

      setLoading(true);
      setDbError(null);
      try {
        // 初期ロード（全置換・暫定 total・COUNT の遅延取得）はリセット時だけ。スクロールで先頭へ
        // 戻っただけの offset 0 はマージ経路へ流し、total の巻き戻りと COUNT の再発行を避ける。
        // 並びの更新は取得範囲の調整（下記）が要るため、初期ロードに入れない
        const isInitialLoad = isReset && !isReorderOnly && query === "" && offset === 0;

        if (isInitialLoad) {
          const initialGhosts = await searchGhostsInitialPage(requestKey, limit, sortOrder);
          if (!isActive) return;

          committedRef.current = { context: contextKey, epoch: sortEpoch };
          setGhosts(initialGhosts);
          setLoadedStart(0);
          bufferRef.current = { ghosts: initialGhosts, start: 0 };

          // 初期描画を優先し、総件数は遅延取得する。ソートの切替など総数が変わらないリセットでは、
          // total を暫定値へ巻き戻さず、COUNT も発行しない
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

        // 並びの更新では、offset の窓ではなく、読込済みのバッファの範囲をそのまま取り直す。
        // offset の窓で取り直すと、先読みで広がったバッファのうち表示中の行が窓から外れ、
        // いったん Skeleton になる
        const prev = bufferRef.current;
        const fetchLimit = isReorderOnly ? prev.ghosts.length : limit;
        const fetchOffset = isReorderOnly ? prev.start : offset;

        // COUNT は総数が変わり得るリセット時だけ発行する（スクロールのページ送り・ソートの切替・
        // 並びの更新では発行しない）。SELECT と並行させ、待ち時間を重ねない
        const [pageGhosts, newTotal] = await Promise.all([
          searchGhosts(requestKey, query, fetchLimit, fetchOffset, sortOrder),
          isReset && needsCount ? countGhostsByQuery(requestKey, query) : Promise.resolve(null),
        ]);
        if (!isActive) return;

        committedRef.current = { context: contextKey, epoch: sortEpoch };

        if (isReset) {
          // コンテキストの変更・並びの更新 → バッファを全置換する
          const next = isReorderOnly ? reuseSameRows(prev.ghosts, pageGhosts) : pageGhosts;
          if (next !== null) {
            setGhosts(next);
            setLoadedStart(fetchOffset);
            bufferRef.current = { ghosts: next, start: fetchOffset };
          }
          if (newTotal !== null) applyCount(newTotal);
        } else {
          // スクロールによる offset 変更 → マージ（total はリセット時の値を保持）
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
