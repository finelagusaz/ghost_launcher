import { describe, it, expect, vi, beforeEach } from "vitest";

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

describe("ghostDatabase - getDb", () => {

  it("初回接続時に PRAGMA journal_mode=WAL を設定する", async () => {
    const { getDb } = await import("./ghostDatabase");
    await getDb();

    expect(mockLoad).toHaveBeenCalledWith("sqlite:ghosts.db");
    expect(mockExecute).toHaveBeenCalledWith("PRAGMA journal_mode=WAL");
  });

  it("初回接続時に PRAGMA busy_timeout=5000 を設定する", async () => {
    const { getDb } = await import("./ghostDatabase");
    await getDb();

    expect(mockExecute).toHaveBeenCalledWith("PRAGMA busy_timeout=5000");
  });

  it("PRAGMA は journal_mode → busy_timeout の順で実行される", async () => {
    const { getDb } = await import("./ghostDatabase");
    await getDb();

    const calls = mockExecute.mock.calls.map((c) => c[0]);
    const walIndex = calls.indexOf("PRAGMA journal_mode=WAL");
    const busyIndex = calls.indexOf("PRAGMA busy_timeout=5000");
    expect(walIndex).toBeLessThan(busyIndex);
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

describe("ghostDatabase - replaceGhostsByRequestKey", () => {
  it("BEGIN/COMMIT/ROLLBACK を使わない（コネクションプール安全）", async () => {
    const { replaceGhostsByRequestKey } = await import("./ghostDatabase");
    await replaceGhostsByRequestKey("rk1", []);

    const sqlCalls = mockExecute.mock.calls.map((c) => c[0] as string);
    const transactionCalls = sqlCalls.filter(
      (sql) => /^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)
    );
    expect(transactionCalls).toEqual([]);
  });

  it("DELETE → INSERT の順で実行される", async () => {
    const { replaceGhostsByRequestKey } = await import("./ghostDatabase");
    const ghosts = [
      { name: "A", directory_name: "a", path: "/a", source: "ssp" },
    ];
    await replaceGhostsByRequestKey("rk1", ghosts);

    const sqlCalls = mockExecute.mock.calls
      .map((c) => c[0] as string)
      .filter((sql) => !sql.startsWith("PRAGMA"));

    expect(sqlCalls[0]).toMatch(/^DELETE FROM ghosts/);
    expect(sqlCalls[1]).toMatch(/^INSERT INTO ghosts/);
  });

  it("ゴーストが空の場合は DELETE のみ実行される", async () => {
    const { replaceGhostsByRequestKey } = await import("./ghostDatabase");
    await replaceGhostsByRequestKey("rk1", []);

    const sqlCalls = mockExecute.mock.calls
      .map((c) => c[0] as string)
      .filter((sql) => !sql.startsWith("PRAGMA"));

    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0]).toMatch(/^DELETE FROM ghosts/);
  });
});
