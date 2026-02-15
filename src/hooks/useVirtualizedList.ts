import { useMemo } from "react";

interface UseVirtualizedListOptions {
  scrollTop: number;
  viewportHeight: number;
  estimatedRowHeight: number;
  overscanRows: number;
}

interface VirtualizedListResult<T> {
  visibleItems: T[];
  startIndex: number;
  endIndex: number;
  topSpacer: number;
  bottomSpacer: number;
}

export function useVirtualizedList<T>(
  items: T[],
  options: UseVirtualizedListOptions,
): VirtualizedListResult<T> {
  const { scrollTop, viewportHeight, estimatedRowHeight, overscanRows } = options;

  return useMemo(() => {
    const visibleRowCount = Math.max(1, Math.ceil(viewportHeight / estimatedRowHeight));
    const startIndex = Math.max(0, Math.floor(scrollTop / estimatedRowHeight) - overscanRows);
    const endIndex = Math.min(items.length, startIndex + visibleRowCount + overscanRows * 2);

    const totalHeight = items.length * estimatedRowHeight;
    const topSpacer = startIndex * estimatedRowHeight;
    const visibleItems = items.slice(startIndex, endIndex);
    const bottomSpacer = Math.max(
      0,
      totalHeight - topSpacer - visibleItems.length * estimatedRowHeight,
    );

    return {
      visibleItems,
      startIndex,
      endIndex,
      topSpacer,
      bottomSpacer,
    };
  }, [estimatedRowHeight, items, overscanRows, scrollTop, viewportHeight]);
}
