import { describe, it, expect } from "vitest";
import shapes from "../test/fixtures/search-sql-shapes.json";
import { GHOST_SEARCH_LOWER_COLUMNS, buildOrderBy } from "./ghostDatabase";

describe("検索 SQL 形状の言語間パリティ", () => {
  it("検索対象列が fixture と一致する", () => {
    expect([...GHOST_SEARCH_LOWER_COLUMNS]).toEqual(shapes.searchLowerColumns);
  });

  it("name/recent/frequency の ORDER BY が fixture と一致する", () => {
    expect(buildOrderBy("name")).toBe(shapes.orderBy.name);
    expect(buildOrderBy("recent")).toBe(shapes.orderBy.recent);
    expect(buildOrderBy("frequency")).toBe(shapes.orderBy.frequency);
  });
});
