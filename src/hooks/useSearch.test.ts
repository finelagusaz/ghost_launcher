import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSearch, MAX_BUFFER_SIZE } from "./useSearch";
import type { GhostView } from "../types";
import { searchGhosts } from "../lib/ghostDatabase";

vi.mock("../lib/ghostDatabase", () => ({
  searchGhosts: vi.fn(),
}));

function makeGhost(name: string, dir: string): GhostView {
  return {
    name,
    directory_name: dir,
    path: `/${dir}`,
    source: "ssp",
    name_lower: name.toLowerCase(),
    directory_name_lower: dir.toLowerCase(),
  };
}

const reimu = makeGhost("Reimu", "hakurei");
const marisa = makeGhost("Marisa", "kirisame");
const alice = makeGhost("Alice", "margatroid");

const mockGhosts: GhostView[] = [reimu, marisa];

describe("useSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requestKey が null の場合は検索しない", async () => {
    const { result } = renderHook(() => useSearch(null, "", 100, 0, 0));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(searchGhosts).not.toHaveBeenCalled();
    expect(result.current.ghosts).toEqual([]);
    expect(result.current.total).toBe(0);
  });

  it("requestKey を渡すと SQLite 検索結果を返す", async () => {
    vi.mocked(searchGhosts).mockResolvedValueOnce({
      ghosts: mockGhosts,
      total: mockGhosts.length,
    });

    const { result } = renderHook(() => useSearch("rk1", "", 100, 0, 0));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.ghosts).toHaveLength(2);
    });

    expect(searchGhosts).toHaveBeenCalledWith("rk1", "", 100, 0);
    expect(result.current.total).toBe(2);
  });

  it("offset 変更時はバッファをマージする", async () => {
    vi.mocked(searchGhosts)
      .mockResolvedValueOnce({ ghosts: [reimu], total: 2 })
      .mockResolvedValueOnce({ ghosts: [marisa], total: 2 });

    const { result, rerender } = renderHook(
      ({ offset }) => useSearch("rk1", "", 1, offset, 1),
      { initialProps: { offset: 0 } }
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.ghosts).toHaveLength(1);
    });
    expect(result.current.loadedStart).toBe(0);

    rerender({ offset: 1 });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.ghosts).toHaveLength(2);
    });

    // 旧データ (Reimu) が保持され、新データ (Marisa) がマージされる
    expect(result.current.ghosts[0].name).toBe("Reimu");
    expect(result.current.ghosts[1].name).toBe("Marisa");
    expect(result.current.loadedStart).toBe(0);
  });

  it("隣接ウィンドウのマージ: 重複部分は上書きされ旧データが保持される", async () => {
    vi.mocked(searchGhosts)
      .mockResolvedValueOnce({ ghosts: [reimu, marisa], total: 3 })
      .mockResolvedValueOnce({ ghosts: [marisa, alice], total: 3 });

    const { result, rerender } = renderHook(
      ({ offset }) => useSearch("rk1", "", 2, offset, 1),
      { initialProps: { offset: 0 } }
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.ghosts).toHaveLength(2);
    });

    rerender({ offset: 1 });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.ghosts).toHaveLength(3);
    });

    expect(result.current.ghosts[0].name).toBe("Reimu");
    expect(result.current.ghosts[1].name).toBe("Marisa");
    expect(result.current.ghosts[2].name).toBe("Alice");
    expect(result.current.loadedStart).toBe(0);
  });

  it("query 変更時はバッファがクリアされる", async () => {
    vi.mocked(searchGhosts)
      .mockResolvedValueOnce({ ghosts: [reimu, marisa], total: 2 })
      .mockResolvedValueOnce({ ghosts: [marisa], total: 1 });

    const { result, rerender } = renderHook(
      ({ query }) => useSearch("rk1", query, 100, 0, 1),
      { initialProps: { query: "" } }
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.ghosts).toHaveLength(2);
    });

    rerender({ query: "ki" });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.ghosts).toHaveLength(1);
    });

    // バッファがクリアされ、新結果のみが返る（旧データとマージされない）
    expect(result.current.ghosts[0].name).toBe("Marisa");
    expect(result.current.total).toBe(1);
    expect(result.current.loadedStart).toBe(0);
  });

  it("refreshTrigger 変更時はバッファがクリアされる", async () => {
    vi.mocked(searchGhosts)
      .mockResolvedValueOnce({ ghosts: [reimu, marisa], total: 2 })
      .mockResolvedValueOnce({ ghosts: [alice], total: 1 });

    const { result, rerender } = renderHook(
      ({ trigger }) => useSearch("rk1", "", 100, 0, trigger),
      { initialProps: { trigger: 1 } }
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.ghosts).toHaveLength(2);
    });

    rerender({ trigger: 2 });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.ghosts).toHaveLength(1);
    });

    // バッファがクリアされ、新結果のみが返る（旧データとマージされない）
    expect(result.current.ghosts[0].name).toBe("Alice");
    expect(result.current.total).toBe(1);
  });

  it("バッファサイズ上限超過時は全置換にフォールバックする", async () => {
    vi.mocked(searchGhosts)
      .mockResolvedValueOnce({ ghosts: [reimu], total: 50000 })
      .mockResolvedValueOnce({ ghosts: [marisa], total: 50000 });

    const farOffset = MAX_BUFFER_SIZE + 100;

    const { result, rerender } = renderHook(
      ({ offset }) => useSearch("rk1", "", 1, offset, 1),
      { initialProps: { offset: 0 } }
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.ghosts).toHaveLength(1);
    });

    rerender({ offset: farOffset });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.ghosts).toHaveLength(1);
    });

    // マージではなく全置換されている
    expect(result.current.ghosts[0].name).toBe("Marisa");
    expect(result.current.loadedStart).toBe(farOffset);
  });

  it("refreshTrigger 変化で検索を再実行する", async () => {
    vi.mocked(searchGhosts)
      .mockResolvedValueOnce({ ghosts: [mockGhosts[0]], total: 1 })
      .mockResolvedValueOnce({ ghosts: mockGhosts, total: 2 });

    const { result, rerender } = renderHook(
      ({ trigger }) => useSearch("rk1", "", 100, 0, trigger),
      { initialProps: { trigger: 1 } }
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.ghosts).toHaveLength(1);
    });

    rerender({ trigger: 2 });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.ghosts).toHaveLength(2);
    });

    expect(searchGhosts).toHaveBeenCalledTimes(2);
  });

  it("requestKey が null → 非null に変わると検索が発火する", async () => {
    vi.mocked(searchGhosts).mockResolvedValueOnce({
      ghosts: mockGhosts,
      total: 2,
    });

    const { result, rerender } = renderHook(
      ({ rk }) => useSearch(rk, "", 100, 0, 1),
      { initialProps: { rk: null as string | null } }
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(searchGhosts).not.toHaveBeenCalled();
    expect(result.current.ghosts).toEqual([]);

    rerender({ rk: "rk1" });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.ghosts).toHaveLength(2);
    });

    expect(searchGhosts).toHaveBeenCalledTimes(1);
    expect(searchGhosts).toHaveBeenCalledWith("rk1", "", 100, 0);
  });

  it("検索でエラーが発生した場合は dbError にメッセージを設定する", async () => {
    vi.mocked(searchGhosts).mockRejectedValueOnce(
      new Error("database is locked")
    );

    const { result } = renderHook(() => useSearch("rk1", "", 100, 0, 1));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.dbError).toBe("database is locked");
    expect(result.current.ghosts).toEqual([]);
  });
});
