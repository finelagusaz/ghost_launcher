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

describe("ghostDatabase - スキーマ修復 (repairGhostDbSchema)", () => {
  it("craftman カラムが欠落している場合は ALTER TABLE と DELETE を実行する", async () => {
    // PRAGMA table_info の応答として craftman を含まないカラム一覧を返す
    mockSelect.mockResolvedValueOnce([{ name: "id" }, { name: "name" }, { name: "directory_name" }]);
    const { repairGhostDbSchema } = await import("./ghostDatabase");
    await repairGhostDbSchema();

    const nonPragmaCalls = mockExecute.mock.calls
      .map((c) => c[0] as string)
      .filter((sql) => !sql.startsWith("PRAGMA"));
    expect(nonPragmaCalls).toContain("ALTER TABLE ghosts ADD COLUMN craftman TEXT NOT NULL DEFAULT ''");
    expect(nonPragmaCalls).toContain("DELETE FROM ghosts");
  });

  it("craftman カラムが存在する場合は修復を実行しない", async () => {
    // PRAGMA table_info の応答として全必須カラムを含む一覧を返す
    mockSelect.mockResolvedValueOnce([
      { name: "id" }, { name: "name" }, { name: "craftman" }, { name: "directory_name" },
      { name: "thumbnail_path" }, { name: "thumbnail_use_self_alpha" }, { name: "thumbnail_kind" },
    ]);
    const { repairGhostDbSchema } = await import("./ghostDatabase");
    await repairGhostDbSchema();

    const executeCalls = mockExecute.mock.calls.map((c) => c[0] as string);
    expect(executeCalls).not.toContain("ALTER TABLE ghosts ADD COLUMN craftman TEXT NOT NULL DEFAULT ''");
  });

  it("thumbnail_path カラムが欠落している場合は ALTER TABLE と DELETE を実行する", async () => {
    mockSelect.mockResolvedValueOnce([
      { name: "id" }, { name: "name" }, { name: "craftman" }, { name: "directory_name" },
      // thumbnail_path 欠落
      { name: "thumbnail_use_self_alpha" },
    ]);
    const { repairGhostDbSchema } = await import("./ghostDatabase");
    await repairGhostDbSchema();

    const nonPragmaCalls = mockExecute.mock.calls
      .map((c) => c[0] as string)
      .filter((sql) => !sql.startsWith("PRAGMA"));
    expect(nonPragmaCalls).toContain("ALTER TABLE ghosts ADD COLUMN thumbnail_path TEXT NOT NULL DEFAULT ''");
    expect(nonPragmaCalls).toContain("DELETE FROM ghosts");
  });

  it("thumbnail_use_self_alpha カラムが欠落している場合は ALTER TABLE と DELETE を実行する", async () => {
    mockSelect.mockResolvedValueOnce([
      { name: "id" }, { name: "name" }, { name: "craftman" }, { name: "directory_name" },
      { name: "thumbnail_path" },
      // thumbnail_use_self_alpha 欠落
    ]);
    const { repairGhostDbSchema } = await import("./ghostDatabase");
    await repairGhostDbSchema();

    const nonPragmaCalls = mockExecute.mock.calls
      .map((c) => c[0] as string)
      .filter((sql) => !sql.startsWith("PRAGMA"));
    expect(nonPragmaCalls).toContain("ALTER TABLE ghosts ADD COLUMN thumbnail_use_self_alpha INTEGER NOT NULL DEFAULT 0");
    expect(nonPragmaCalls).toContain("DELETE FROM ghosts");
  });

  it("thumbnail_kind カラムが欠落している場合は ALTER TABLE と DELETE を実行する", async () => {
    mockSelect.mockResolvedValueOnce([
      { name: "id" }, { name: "name" }, { name: "craftman" }, { name: "directory_name" },
      { name: "thumbnail_path" }, { name: "thumbnail_use_self_alpha" },
      // thumbnail_kind 欠落
    ]);
    const { repairGhostDbSchema } = await import("./ghostDatabase");
    await repairGhostDbSchema();

    const nonPragmaCalls = mockExecute.mock.calls
      .map((c) => c[0] as string)
      .filter((sql) => !sql.startsWith("PRAGMA"));
    expect(nonPragmaCalls).toContain("ALTER TABLE ghosts ADD COLUMN thumbnail_kind TEXT NOT NULL DEFAULT ''");
    expect(nonPragmaCalls).toContain("DELETE FROM ghosts");
  });

  it("テーブルが存在しない場合（PRAGMA が空を返す場合）は修復を実行しない", async () => {
    // mockSelect のデフォルトは [] なのでそのまま使う
    const { repairGhostDbSchema } = await import("./ghostDatabase");
    await repairGhostDbSchema();

    const executeCalls = mockExecute.mock.calls.map((c) => c[0] as string);
    expect(executeCalls).not.toContain("ALTER TABLE ghosts ADD COLUMN craftman TEXT NOT NULL DEFAULT ''");
  });
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

describe("ghostDatabase - insertGhostsBatch NFKC正規化", () => {
  it("全角英字のゴースト名を NFKC 正規化してから小文字化して格納する", async () => {
    const { insertGhostsBatch } = await import("./ghostDatabase");
    const ghosts = [
      { name: "Ａｌｉｃｅ", craftman: "", directory_name: "Ａｌｉｃｅ", path: "/alice", source: "ssp", thumbnail_path: "", thumbnail_use_self_alpha: false, thumbnail_kind: "" },
    ];
    await insertGhostsBatch("rk1", ghosts);

    const insertCall = mockExecute.mock.calls.find((c) =>
      (c[0] as string).startsWith("INSERT INTO ghosts")
    );
    expect(insertCall).toBeDefined();
    // params: [requestKey, name, craftman, directory_name, path, source, name_lower, directory_name_lower, thumbnail_path, thumbnail_use_self_alpha, thumbnail_kind]
    const params = insertCall![1] as (string | number)[];
    expect(params[6]).toBe("alice"); // "Ａｌｉｃｅ".normalize("NFKC").toLowerCase()
    expect(params[7]).toBe("alice");
  });
});

describe("ghostDatabase - searchGhosts NFKC正規化", () => {
  it("全角英字クエリを NFKC 正規化してから小文字化した LIKE パターンで検索する", async () => {
    mockSelect.mockResolvedValue([{ count: 0 }]);
    const { searchGhosts } = await import("./ghostDatabase");
    await searchGhosts("rk1", "Ａｌｉｃｅ", 50, 0);

    const countCall = mockSelect.mock.calls[0];
    // params: [requestKey, likePattern, likePattern]
    expect(countCall[1][1]).toBe("%alice%");
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
      { name: "A", craftman: "", directory_name: "a", path: "/a", source: "ssp", thumbnail_path: "", thumbnail_use_self_alpha: false, thumbnail_kind: "" },
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

describe("ghostDatabase - cleanupOldGhostCaches", () => {
  it("世代上限とTTLに基づき古い request_key を削除する", async () => {
    const now = new Date();
    const iso = (daysAgo: number) => new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    mockSelect.mockResolvedValue([
      { request_key: "rk-current", last_updated: iso(0) },
      { request_key: "rk-recent", last_updated: iso(1) },
      { request_key: "rk-old", last_updated: iso(40) },
    ]);

    const { cleanupOldGhostCaches } = await import("./ghostDatabase");
    const keep = await cleanupOldGhostCaches("rk-current", 2, 30);

    expect(keep).toContain("rk-current");
    expect(keep).toContain("rk-recent");
    const deleteCall = mockExecute.mock.calls.find((c) =>
      (c[0] as string).startsWith("DELETE FROM ghosts WHERE request_key IN")
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall![1]).toEqual(["rk-old"]);
  });

  it("currentRequestKey が DB に存在しない場合でも戻り値に含まれる", async () => {
    mockSelect.mockResolvedValue([
      { request_key: "rk-other", last_updated: new Date().toISOString() },
    ]);

    const { cleanupOldGhostCaches } = await import("./ghostDatabase");
    const keep = await cleanupOldGhostCaches("rk-new", 5, 30);

    expect(keep).toContain("rk-new");
  });

  it("全エントリが TTL 切れでも currentRequestKey のみ保持される（バグ修正リグレッション）", async () => {
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    mockSelect.mockResolvedValue([
      { request_key: "rk-current", last_updated: iso(40) },
      { request_key: "rk-stale", last_updated: iso(40) },
    ]);

    const { cleanupOldGhostCaches } = await import("./ghostDatabase");
    const keep = await cleanupOldGhostCaches("rk-current", 5, 30);

    expect(keep).toContain("rk-current");
    expect(keep).not.toContain("rk-stale");
    const deleteCall = mockExecute.mock.calls.find((c) =>
      (c[0] as string).startsWith("DELETE FROM ghosts WHERE request_key IN")
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall![1]).toEqual(["rk-stale"]);
  });

  it("maxGenerations=0 のとき currentRequestKey のみ保持される", async () => {
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    mockSelect.mockResolvedValue([
      { request_key: "rk-current", last_updated: iso(0) },
      { request_key: "rk-other", last_updated: iso(1) },
    ]);

    const { cleanupOldGhostCaches } = await import("./ghostDatabase");
    const keep = await cleanupOldGhostCaches("rk-current", 0, 30);

    expect(keep).toContain("rk-current");
    expect(keep).not.toContain("rk-other");
  });
});
