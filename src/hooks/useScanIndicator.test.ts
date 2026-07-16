import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScanIndicator, SCAN_INDICATOR_DELAY_MS } from "./useScanIndicator";

describe("useScanIndicator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("active が しきい値未満で解除されると一度も true にならない（ちらつき防止）", () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useScanIndicator(active),
      { initialProps: { active: true } },
    );
    act(() => { vi.advanceTimersByTime(SCAN_INDICATOR_DELAY_MS - 1); });
    expect(result.current).toBe(false);
    rerender({ active: false });
    act(() => { vi.advanceTimersByTime(10); });
    expect(result.current).toBe(false);
  });

  it("active が しきい値以上継続で true になる", () => {
    const { result } = renderHook(
      ({ active }: { active: boolean }) => useScanIndicator(active),
      { initialProps: { active: true } },
    );
    act(() => { vi.advanceTimersByTime(SCAN_INDICATOR_DELAY_MS); });
    expect(result.current).toBe(true);
  });

  it("true の後に active=false で即 false に戻る", () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useScanIndicator(active),
      { initialProps: { active: true } },
    );
    act(() => { vi.advanceTimersByTime(SCAN_INDICATOR_DELAY_MS); });
    expect(result.current).toBe(true);
    rerender({ active: false });
    expect(result.current).toBe(false);
  });
});
