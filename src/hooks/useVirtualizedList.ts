import { useCallback, useRef, useState } from "react";

interface UseVirtualizedListOptions {
  viewportHeight: number;
  estimatedRowHeight: number;
  overscanRows: number;
  gap?: number;
}

interface VirtualizedListResult<T> {
  visibleItems: T[];
  startIndex: number;
  endIndex: number;
  topSpacer: number;
  bottomSpacer: number;
  onScroll: (event: React.UIEvent<HTMLElement>) => void;
}

function calcIndices(
  scrollTop: number,
  viewportHeight: number,
  itemCount: number,
  rowHeight: number,
  overscanRows: number,
): [number, number] {
  const visibleRowCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscanRows);
  const end = Math.min(itemCount, start + visibleRowCount + overscanRows * 2);
  return [start, end];
}

export function useVirtualizedList<T>(
  items: T[],
  options: UseVirtualizedListOptions,
): VirtualizedListResult<T> {
  const { viewportHeight, estimatedRowHeight, overscanRows, gap = 0 } = options;
  const rowHeight = estimatedRowHeight + gap;

  const [indices, setIndices] = useState<[number, number]>(() =>
    calcIndices(0, viewportHeight, items.length, rowHeight, overscanRows),
  );

  const rafRef = useRef(0);
  const scrollTopRef = useRef(0);
  const prevIndicesRef = useRef(indices);

  // items/options が変わった場合はインデックスをリセット
  const prevItemsLenRef = useRef(items.length);
  const prevRowHeightRef = useRef(rowHeight);
  const prevViewportRef = useRef(viewportHeight);

  if (
    prevItemsLenRef.current !== items.length ||
    prevRowHeightRef.current !== rowHeight ||
    prevViewportRef.current !== viewportHeight
  ) {
    prevItemsLenRef.current = items.length;
    prevRowHeightRef.current = rowHeight;
    prevViewportRef.current = viewportHeight;
    const newIndices = calcIndices(scrollTopRef.current, viewportHeight, items.length, rowHeight, overscanRows);
    prevIndicesRef.current = newIndices;
    setIndices(newIndices);
  }

  const onScroll = useCallback(
    (event: React.UIEvent<HTMLElement>) => {
      const scrollTop = event.currentTarget.scrollTop;
      scrollTopRef.current = scrollTop;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const next = calcIndices(scrollTop, viewportHeight, items.length, rowHeight, overscanRows);
        if (next[0] !== prevIndicesRef.current[0] || next[1] !== prevIndicesRef.current[1]) {
          prevIndicesRef.current = next;
          setIndices(next);
        }
      });
    },
    [viewportHeight, items.length, rowHeight, overscanRows],
  );

  const [startIndex, endIndex] = indices;
  const topSpacer = startIndex * rowHeight;
  const visibleItems = items.slice(startIndex, endIndex);
  const bottomSpacer = (items.length - endIndex) * rowHeight;

  return {
    visibleItems,
    startIndex,
    endIndex,
    topSpacer,
    bottomSpacer,
    onScroll,
  };
}
