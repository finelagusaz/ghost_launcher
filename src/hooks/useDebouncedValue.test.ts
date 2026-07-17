import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebouncedValue } from "./useDebouncedValue";

describe("useDebouncedValue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("初期値は即時に返す", () => {
    const { result } = renderHook(() => useDebouncedValue("a", 150));
    expect(result.current).toBe("a");
  });

  it("変更は delay 経過後にのみ反映される", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 150),
      { initialProps: { value: "a" } }
    );

    rerender({ value: "ab" });
    expect(result.current).toBe("a");

    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(result.current).toBe("a");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("ab");
  });

  it("連続変更は最後の値だけに合流する（途中の値は反映されない）", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 150),
      { initialProps: { value: "" } }
    );

    // タイピングを模擬: 100ms 間隔で s → さ → さく → さくら
    for (const value of ["s", "さ", "さく", "さくら"]) {
      rerender({ value });
      act(() => {
        vi.advanceTimersByTime(100);
      });
    }
    // 最後の変更からまだ 100ms → 未反映
    expect(result.current).toBe("");

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current).toBe("さくら");
  });
});
