import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSearch } from "./useSearch";
import type { GhostView } from "../types";

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
  it("空クエリでは全件返す", () => {
    const { result } = renderHook(() => useSearch(mockGhosts, ""));
    expect(result.current).toHaveLength(2);
  });
  it("name で部分一致フィルタリングする", () => {
    const { result } = renderHook(() => useSearch(mockGhosts, "reim"));
    expect(result.current).toHaveLength(1);
    expect(result.current[0].name).toBe("Reimu");
  });
  it("directory_name で部分一致フィルタリングする", () => {
    const { result } = renderHook(() => useSearch(mockGhosts, "kiris"));
    expect(result.current).toHaveLength(1);
    expect(result.current[0].directory_name).toBe("kirisame");
  });
  it("大文字小文字を区別しない", () => {
    const { result } = renderHook(() => useSearch(mockGhosts, "REIMU"));
    expect(result.current).toHaveLength(1);
  });
  it("スペースのみのクエリでは全件返す", () => {
    const { result } = renderHook(() => useSearch(mockGhosts, "  "));
    expect(result.current).toHaveLength(2);
  });
});
