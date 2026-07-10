import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useVirtualizedList } from "./useVirtualizedList";

// rowHeight = estimatedRowHeight + gap = 90 + 10 = 100
// visibleRowCount = max(1, ceil(400 / 100)) = 4
const options = { viewportHeight: 400, estimatedRowHeight: 90, overscanRows: 3, gap: 10, totalCount: 1000 };

describe("useVirtualizedList", () => {
  it("初期状態は先頭から可視行 + overscan*2 を返す", () => {
    const { result } = renderHook(() => useVirtualizedList([], options));
    expect(result.current.startIndex).toBe(0);
    expect(result.current.endIndex).toBe(10); // 0 + 4 + 3*2
    expect(result.current.topSpacer).toBe(0);
    expect(result.current.bottomSpacer).toBe((1000 - 10) * 100);
  });

  it("totalCount 未指定なら items.length でスクロール空間を計算する", () => {
    const { result } = renderHook(() =>
      useVirtualizedList(new Array(6).fill(null), { ...options, totalCount: undefined }),
    );
    expect(result.current.endIndex).toBe(6); // itemCount=6 にクランプ
    expect(result.current.bottomSpacer).toBe(0);
  });

  it("totalCount の減少でインデックスとスクロール空間を再計算する", () => {
    const { result, rerender } = renderHook(
      ({ total }: { total: number }) => useVirtualizedList([], { ...options, totalCount: total }),
      { initialProps: { total: 1000 } },
    );
    rerender({ total: 5 });
    expect(result.current.endIndex).toBe(5);
    expect(result.current.bottomSpacer).toBe(0);
  });

  it("itemCount が 0 でも負のインデックスにならない", () => {
    const { result } = renderHook(() => useVirtualizedList([], { ...options, totalCount: 0 }));
    expect(result.current.startIndex).toBe(0);
    expect(result.current.endIndex).toBe(0);
    expect(result.current.bottomSpacer).toBe(0);
  });
});
