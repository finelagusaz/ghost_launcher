import { describe, it, expect, vi, beforeEach } from "vitest";
import cases from "../test/fixtures/normalize-key-cases.json";
import ghostViewColumns from "../test/fixtures/ghost-view-columns.json";

const mockExecute = vi.fn().mockResolvedValue({ rowsAffected: 0 });
const mockSelect = vi.fn().mockResolvedValue([]);
const mockLoad = vi.fn().mockResolvedValue({
  execute: mockExecute,
  select: mockSelect,
});

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: mockLoad,
  },
}));

beforeEach(() => {
  vi.resetModules();
  mockExecute.mockClear();
  mockSelect.mockClear();
  mockLoad.mockClear();
});

describe("ghostDatabase - GhostView 列同期", () => {
  it("GHOST_VIEW_COLUMNS が共有 fixture と一致する", async () => {
    // Rust 側テスト（lib.rs）が同じ fixture を ghosts スキーマと照合することで、
    // GhostView 型（コンパイル時検査）・SELECT 列・SQLite スキーマの三者同期を縛る
    const { GHOST_VIEW_COLUMNS } = await import("./ghostDatabase");
    expect([...GHOST_VIEW_COLUMNS]).toEqual(ghostViewColumns);
  });
});

describe("ghostDatabase - getDb Promise 重複防止", () => {
  it("並行呼び出しで loadDb が 1 回だけ実行される", async () => {
    const { getDb } = await import("./ghostDatabase");
    const [db1, db2] = await Promise.all([getDb(), getDb()]);

    expect(db1).toBe(db2);
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it("初回失敗後に再呼び出しで再試行できる", async () => {
    mockLoad
      .mockRejectedValueOnce(new Error("disk I/O error"))
      .mockResolvedValueOnce({ execute: mockExecute, select: mockSelect });

    const { getDb } = await import("./ghostDatabase");
    await expect(getDb()).rejects.toThrow("disk I/O error");

    // Promise がリセットされているので再試行可能
    const db = await getDb();
    expect(db).toBeDefined();
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });
});

describe("ghostDatabase - getDb", () => {

  it("初回接続時に PRAGMA busy_timeout=5000 を設定する", async () => {
    const { getDb } = await import("./ghostDatabase");
    await getDb();

    expect(mockLoad).toHaveBeenCalledWith("sqlite:ghosts.db");
    expect(mockExecute).toHaveBeenCalledWith("PRAGMA busy_timeout=5000");
  });

  it("2回目の getDb() では PRAGMA を再実行しない（シングルトン）", async () => {
    const { getDb } = await import("./ghostDatabase");
    const db1 = await getDb();
    mockExecute.mockClear();
    mockLoad.mockClear();

    const db2 = await getDb();

    expect(db1).toBe(db2);
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe("ghostDatabase - searchGhosts NFKC正規化", () => {
  it("全角英字クエリを NFKC 正規化してから小文字化した LIKE パターンで検索する", async () => {
    mockSelect.mockResolvedValue([{ count: 0 }]);
    const { searchGhosts } = await import("./ghostDatabase");
    await searchGhosts("rk1", "Ａｌｉｃｅ", 50, 0);

    const countCall = mockSelect.mock.calls.find((c) =>
      (c[0] as string).includes("COUNT(*)"));
    expect(countCall).toBeDefined();
    expect(countCall![1][1]).toBe("%alice%");
  });
});


describe("ghostDatabase - searchGhostsInitialPage", () => {
  it("初期ページ取得は LIKE や OFFSET を使わず request_key + ORDER BY + LIMIT で取得する", async () => {
    mockSelect.mockResolvedValue([]);
    const { searchGhostsInitialPage } = await import("./ghostDatabase");
    await searchGhostsInitialPage("rk1", 50);

    const call = mockSelect.mock.calls.find((c) =>
      (c[0] as string).includes("SELECT"));
    expect(call).toBeDefined();
    const sql = call![0] as string;
    expect(sql).toContain("WHERE g.request_key = ?");
    expect(sql).toContain("ORDER BY g.name_lower ASC");
    expect(sql).toContain("LIMIT ?");
    expect(sql).not.toContain("LIKE");
    expect(sql).not.toContain("OFFSET");
    expect(call![1]).toEqual(["rk1", 50]);
  });
});

describe("ghostDatabase - random ソートの安定シード", () => {
  it("searchGhosts が random でシード付き ORDER BY を発行する", async () => {
    const { searchGhosts } = await import("./ghostDatabase");
    await searchGhosts("rk", "", 10, 0, "random");
    const sql = mockSelect.mock.calls
      .map((c) => c[0] as string)
      .find((q) => q.includes("ORDER BY"));
    expect(sql).toMatch(/\(g\.id \* \d+\) % 1000003, g\.id/);
  });

  it("同一シード中は searchGhostsInitialPage も同じ ORDER BY 式を使う", async () => {
    const { searchGhosts, searchGhostsInitialPage } = await import("./ghostDatabase");
    await searchGhosts("rk", "", 10, 0, "random");
    await searchGhostsInitialPage("rk", 10, "random");
    const sqls = mockSelect.mock.calls
      .map((c) => c[0] as string)
      .filter((q) => q.includes("% 1000003"));
    const seedOf = (q: string) => q.match(/g\.id \* (\d+)/)?.[1];
    expect(sqls.length).toBeGreaterThanOrEqual(2);
    expect(seedOf(sqls[0])).toBe(seedOf(sqls[1]));
  });

  it("reseedRandomSort でシードが変わる", async () => {
    const randomSpy = vi
      .spyOn(Math, "random")
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.9);
    const { searchGhosts, reseedRandomSort } = await import("./ghostDatabase");
    await searchGhosts("rk", "", 10, 0, "random");
    reseedRandomSort();
    await searchGhosts("rk", "", 10, 0, "random");
    const sqls = mockSelect.mock.calls
      .map((c) => c[0] as string)
      .filter((q) => q.includes("% 1000003"));
    expect(sqls[0]).not.toEqual(sqls[1]);
    randomSpy.mockRestore();
  });
});

describe("buildOrderBy", () => {
  it("recent は JOIN なしで last_launched 列を並べる", async () => {
    const { buildOrderBy } = await import("./ghostDatabase");
    const orderBy = buildOrderBy("recent");
    expect(orderBy).toContain("g.last_launched DESC");
    expect(orderBy).not.toContain("JOIN");
    expect(orderBy).not.toContain("ghost_launches");
  });

  it("frequency は JOIN なしで launch_count 列を並べる", async () => {
    const { buildOrderBy } = await import("./ghostDatabase");
    const orderBy = buildOrderBy("frequency");
    expect(orderBy).toContain("g.launch_count DESC");
    expect(orderBy).not.toContain("JOIN");
  });

  it("name は name_lower を昇順で並べる", async () => {
    const { buildOrderBy } = await import("./ghostDatabase");
    expect(buildOrderBy("name")).toContain("g.name_lower ASC");
  });
});

describe("ghostDatabase - countGhostsByQuery", () => {
  it("空クエリ時は LIKE なしで件数取得する", async () => {
    mockSelect.mockResolvedValue([{ count: 42 }]);
    const { countGhostsByQuery } = await import("./ghostDatabase");
    const total = await countGhostsByQuery("rk1", "");

    expect(total).toBe(42);
    const call = mockSelect.mock.calls.find((c) =>
      (c[0] as string).includes("COUNT(*)"));
    expect(call).toBeDefined();
    expect(call![0]).toBe("SELECT COUNT(*) as count FROM ghosts WHERE request_key = ?");
    expect(call![1]).toEqual(["rk1"]);
  });

  it("非空クエリ時は NFKC 正規化した LIKE で件数取得する", async () => {
    mockSelect.mockResolvedValue([{ count: 1 }]);
    const { countGhostsByQuery } = await import("./ghostDatabase");
    const total = await countGhostsByQuery("rk1", "Ａｌｉｃｅ");

    expect(total).toBe(1);
    const call = mockSelect.mock.calls.find((c) =>
      (c[0] as string).includes("COUNT(*)"));
    expect(call).toBeDefined();
    expect(call![1][1]).toBe("%alice%");
  });
});
describe("ghostDatabase - getCachedFingerprint", () => {
  it("request_key が存在する場合は fingerprint を返す", async () => {
    mockSelect.mockResolvedValue([{ fingerprint: "fp-abc" }]);
    const { getCachedFingerprint } = await import("./ghostDatabase");
    const result = await getCachedFingerprint("rk1");

    expect(result).toBe("fp-abc");
    const call = mockSelect.mock.calls.find((c) =>
      (c[0] as string).includes("ghost_fingerprints")
    );
    expect(call).toBeDefined();
    expect(call![0]).toContain("SELECT fingerprint FROM ghost_fingerprints WHERE request_key = ?");
    expect(call![1]).toEqual(["rk1"]);
  });

  it("request_key が存在しない場合は null を返す", async () => {
    mockSelect.mockResolvedValue([]);
    const { getCachedFingerprint } = await import("./ghostDatabase");
    const result = await getCachedFingerprint("rk-missing");

    expect(result).toBeNull();
  });
});

describe("cleanupOldGhostCaches", () => {
  it("cleanup_ghost_caches IPC を camelCase 引数で呼ぶ", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue(1);
    const { cleanupOldGhostCaches } = await import("./ghostDatabase");
    await cleanupOldGhostCaches("c:/ssp::");
    expect(invoke).toHaveBeenCalledWith("cleanup_ghost_caches", { currentRequestKey: "c:/ssp::" });
  });
});

describe("recordLaunch", () => {
  it("record_launch IPC を camelCase 引数で呼ぶ", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const { recordLaunch } = await import("./ghostDatabase");
    vi.mocked(invoke).mockResolvedValue(undefined);
    await recordLaunch("sspmy_ghost");
    expect(invoke).toHaveBeenCalledWith("record_launch", { ghostIdentityKey: "sspmy_ghost" });
  });
});

describe("normalizeForKey パリティ（共有 fixture）", () => {
  it.each(cases)("normalizeForKey($input) === $expected", async ({ input, expected }) => {
    const { normalizeForKey } = await import("./ghostDatabase");
    expect(normalizeForKey(input)).toBe(expected);
  });
});
