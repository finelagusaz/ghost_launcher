import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const { mockRefreshGhostCatalog } = vi.hoisted(() => ({ mockRefreshGhostCatalog: vi.fn() }));
vi.mock("../lib/ghostCatalogService", () => ({ refreshGhostCatalog: mockRefreshGhostCatalog }));

import { useGhosts } from "./useGhosts";

beforeEach(() => {
  mockRefreshGhostCatalog.mockReset();
  mockRefreshGhostCatalog.mockResolvedValue({ skipped: false });
});

describe("useGhosts", () => {
  it("マウント時に refresh が走り loading が収束する", async () => {
    const { result } = renderHook(() => useGhosts("C:/ssp", []));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockRefreshGhostCatalog).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it("同一 inFlightKey の並行 refresh は 1 回に抑止される", async () => {
    let resolveScan: ((v: { skipped: boolean }) => void) | undefined;
    mockRefreshGhostCatalog.mockImplementation(
      () => new Promise((resolve) => { resolveScan = resolve; }),
    );
    const { result } = renderHook(() => useGhosts("C:/ssp", []));
    // マウント時の refresh が in-flight の間に同一キーで再度呼ぶ
    await act(async () => {
      void result.current.refresh();
      void result.current.refresh();
    });
    expect(mockRefreshGhostCatalog).toHaveBeenCalledTimes(1);
    await act(async () => { resolveScan?.({ skipped: false }); });
  });

  it("forceFullScan は別 inFlightKey なので抑止されない", async () => {
    let resolveScan: ((v: { skipped: boolean }) => void) | undefined;
    mockRefreshGhostCatalog.mockImplementation(
      () => new Promise((resolve) => { resolveScan = resolve; }),
    );
    const { result } = renderHook(() => useGhosts("C:/ssp", []));
    await act(async () => {
      void result.current.refresh({ forceFullScan: true });
    });
    expect(mockRefreshGhostCatalog).toHaveBeenCalledTimes(2);
    await act(async () => { resolveScan?.({ skipped: false }); });
  });

  it("スキャン失敗でエラーメッセージが設定される", async () => {
    mockRefreshGhostCatalog.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useGhosts("C:/ssp", []));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toContain("boom");
  });

  it("sspPath が null なら refresh せず loading が収束する", async () => {
    const { result } = renderHook(() => useGhosts(null, []));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockRefreshGhostCatalog).not.toHaveBeenCalled();
  });
});
