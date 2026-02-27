import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAppShellState } from "./useAppShellState";

function createProps(overrides: Partial<Parameters<typeof useAppShellState>[0]> = {}) {
  return {
    settingsLoading: true,
    sspPath: "C:/SSP",
    deferredSearchQuery: "",
    ghostsLoading: true,
    ...overrides,
  };
}

describe("useAppShellState", () => {
  it("sspPath 未設定になったら settingsOpen を自動で true にする", () => {
    const { result, rerender } = renderHook((props) => useAppShellState(props), {
      initialProps: createProps(),
    });

    expect(result.current.settingsOpen).toBe(false);

    rerender(createProps({ settingsLoading: false, sspPath: null }));

    expect(result.current.settingsOpen).toBe(true);
  });

  it("deferredSearchQuery 変更時に offset を 0 に戻す", () => {
    const { result, rerender } = renderHook((props) => useAppShellState(props), {
      initialProps: createProps(),
    });

    act(() => {
      result.current.increaseOffset(100);
    });
    expect(result.current.offset).toBe(100);

    rerender(createProps({ deferredSearchQuery: "marisa" }));

    expect(result.current.offset).toBe(0);
  });

  it("ghostsLoading が true から false になったとき refreshTrigger を増やす", () => {
    const { result, rerender } = renderHook((props) => useAppShellState(props), {
      initialProps: createProps({ ghostsLoading: true }),
    });

    expect(result.current.refreshTrigger).toBe(0);

    rerender(createProps({ ghostsLoading: false }));

    expect(result.current.refreshTrigger).toBe(1);
  });

  it("openSettings/closeSettings で設定ダイアログ状態を変更できる", () => {
    const { result } = renderHook((props) => useAppShellState(props), {
      initialProps: createProps(),
    });

    act(() => {
      result.current.openSettings();
    });
    expect(result.current.settingsOpen).toBe(true);

    act(() => {
      result.current.closeSettings();
    });
    expect(result.current.settingsOpen).toBe(false);
  });
});
