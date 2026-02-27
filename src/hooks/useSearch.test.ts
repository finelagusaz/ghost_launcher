import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSearch } from "./useSearch";
import type { GhostView } from "../types";
import { searchGhosts } from "../lib/ghostDatabase";

vi.mock("../lib/ghostDatabase", () => ({
  searchGhosts: vi.fn(),
}));

const mockGhosts: GhostView[] = [
  {
    name: "Reimu",
    directory_name: "hakurei",
    path: "/hakurei",
    source: "ssp",
    name_lower: "reimu",
    directory_name_lower: "hakurei",
  },
  {
    name: "Marisa",
    directory_name: "kirisame",
    path: "/kirisame",
    source: "ssp",
    name_lower: "marisa",
    directory_name_lower: "kirisame",
  },
];

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

  it("offset > 0 の場合は結果を追記する", async () => {
    vi.mocked(searchGhosts)
      .mockResolvedValueOnce({ ghosts: [mockGhosts[0]], total: 2 })
      .mockResolvedValueOnce({ ghosts: [mockGhosts[1]], total: 2 });

    const { result, rerender } = renderHook(
      ({ offset }) => useSearch("rk1", "", 1, offset, 0),
      { initialProps: { offset: 0 } }
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.ghosts).toHaveLength(1);
    });

    rerender({ offset: 1 });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.ghosts).toHaveLength(2);
    });

    expect(result.current.ghosts[0].name).toBe("Reimu");
    expect(result.current.ghosts[1].name).toBe("Marisa");
  });
});
