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

describe("ghostDatabase - getDb マイグレーションエラー回復", () => {
  it("migration エラー時に reset_ghost_db を呼んで再接続する", async () => {
    mockLoad
      .mockRejectedValueOnce(new Error("while executing migration 4: duplicate column name: craftman"))
      .mockResolvedValueOnce({ execute: mockExecute, select: mockSelect });

    const { invoke: mockInvoke } = await import("@tauri-apps/api/core");
    const { getDb } = await import("./ghostDatabase");
    const db = await getDb();

    expect(db).toBeDefined();
    expect(mockInvoke).toHaveBeenCalledWith("reset_ghost_db");
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it("migration 以外のエラーはそのまま throw する", async () => {
    mockLoad.mockRejectedValueOnce(new Error("disk I/O error"));

    const { invoke: mockInvoke } = await import("@tauri-apps/api/core");
    const { getDb } = await import("./ghostDatabase");
    await expect(getDb()).rejects.toThrow("disk I/O error");
    expect(mockInvoke).not.toHaveBeenCalledWith("reset_ghost_db");
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

  it("初回接続時に PRAGMA journal_size_limit を設定する", async () => {
    const { getDb } = await import("./ghostDatabase");
    await getDb();

    expect(mockExecute).toHaveBeenCalledWith("PRAGMA journal_size_limit=4194304");
  });

  it("初回接続時に PRAGMA optimize を全テーブル対象で実行する", async () => {
    const { getDb } = await import("./ghostDatabase");
    await getDb();

    expect(mockExecute).toHaveBeenCalledWith("PRAGMA optimize=0x10002");
  });

  it("PRAGMA は journal_mode → busy_timeout → journal_size_limit → optimize の順で実行される", async () => {
    const { getDb } = await import("./ghostDatabase");
    await getDb();

    const calls = mockExecute.mock.calls.map((c) => c[0]);
    const walIndex = calls.indexOf("PRAGMA journal_mode=WAL");
    const busyIndex = calls.indexOf("PRAGMA busy_timeout=5000");
    const journalLimitIndex = calls.indexOf("PRAGMA journal_size_limit=4194304");
    const optimizeIndex = calls.indexOf("PRAGMA optimize=0x10002");
    expect(walIndex).toBeLessThan(busyIndex);
    expect(busyIndex).toBeLessThan(journalLimitIndex);
    expect(journalLimitIndex).toBeLessThan(optimizeIndex);
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

describe("ghostDatabase - 条件付き VACUUM", () => {
  it("未使用率25%以上かつ未使用サイズ1MB以上のとき VACUUM を実行する", async () => {
    // page_count=1000, freelist_count=300, page_size=4096
    // → 未使用率30%, 未使用サイズ1.2MB
    mockSelect
      .mockResolvedValueOnce([{ page_count: 1000 }])
      .mockResolvedValueOnce([{ freelist_count: 300 }])
      .mockResolvedValueOnce([{ page_size: 4096 }]);

    const { getDb } = await import("./ghostDatabase");
    await getDb();

    const sqlCalls = mockExecute.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls).toContain("VACUUM");
  });

  it("閾値境界（ちょうど25%・ちょうど1MB）のとき VACUUM を実行する", async () => {
    // page_count=1024, freelist_count=256, page_size=4096
    // → 未使用率25.0%（ちょうど閾値）, 未使用サイズ 256*4096=1,048,576=1MB（ちょうど閾値）
    mockSelect
      .mockResolvedValueOnce([{ page_count: 1024 }])
      .mockResolvedValueOnce([{ freelist_count: 256 }])
      .mockResolvedValueOnce([{ page_size: 4096 }]);

    const { getDb } = await import("./ghostDatabase");
    await getDb();

    const sqlCalls = mockExecute.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls).toContain("VACUUM");
  });

  it("未使用率が閾値未満のとき VACUUM をスキップする", async () => {
    // page_count=1000, freelist_count=100, page_size=4096
    // → 未使用率10% < 25%
    mockSelect
      .mockResolvedValueOnce([{ page_count: 1000 }])
      .mockResolvedValueOnce([{ freelist_count: 100 }])
      .mockResolvedValueOnce([{ page_size: 4096 }]);

    const { getDb } = await import("./ghostDatabase");
    await getDb();

    const sqlCalls = mockExecute.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls).not.toContain("VACUUM");
  });

  it("未使用サイズが閾値未満のとき VACUUM をスキップする", async () => {
    // page_count=100, freelist_count=50, page_size=4096
    // → 未使用率50% > 25%, しかし未使用サイズ200KB < 1MB
    mockSelect
      .mockResolvedValueOnce([{ page_count: 100 }])
      .mockResolvedValueOnce([{ freelist_count: 50 }])
      .mockResolvedValueOnce([{ page_size: 4096 }]);

    const { getDb } = await import("./ghostDatabase");
    await getDb();

    const sqlCalls = mockExecute.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls).not.toContain("VACUUM");
  });

  it("page_count=0（新規DB）のとき VACUUM をスキップする", async () => {
    mockSelect.mockResolvedValueOnce([{ page_count: 0 }]);

    const { getDb } = await import("./ghostDatabase");
    await getDb();

    const sqlCalls = mockExecute.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls).not.toContain("VACUUM");
  });

  it("VACUUM が失敗しても DB 接続は正常に完了する", async () => {
    mockSelect
      .mockResolvedValueOnce([{ page_count: 1000 }])
      .mockResolvedValueOnce([{ freelist_count: 300 }])
      .mockResolvedValueOnce([{ page_size: 4096 }]);
    mockExecute.mockImplementation((sql: string) => {
      if (sql === "VACUUM") return Promise.reject(new Error("database or disk is full"));
      return Promise.resolve({ rowsAffected: 0 });
    });

    const { getDb } = await import("./ghostDatabase");
    const db = await getDb();

    expect(db).toBeDefined();
  });
});

describe("ghostDatabase - insertGhostsBatch NFKC正規化", () => {
  it("全角英字のゴースト名を NFKC 正規化してから小文字化して格納する", async () => {
    const { insertGhostsBatch } = await import("./ghostDatabase");
    const ghosts = [
      { name: "Ａｌｉｃｅ", sakura_name: "", kero_name: "", craftman: "", craftmanw: "", directory_name: "Ａｌｉｃｅ", path: "/alice", source: "ssp", thumbnail_path: "", thumbnail_use_self_alpha: false, thumbnail_kind: "", diff_fingerprint: "fp" },
    ];
    await insertGhostsBatch("rk1", ghosts);

    const insertCall = mockExecute.mock.calls.find((c) =>
      (c[0] as string).startsWith("INSERT INTO ghosts")
    );
    expect(insertCall).toBeDefined();
    // params: [requestKey, ghost_identity_key, row_fingerprint, name, sakura_name, kero_name, craftman, craftmanw, directory_name, path, source, name_lower, sakura_name_lower, kero_name_lower, craftman_lower, craftmanw_lower, directory_name_lower, thumbnail_path, thumbnail_use_self_alpha, thumbnail_kind]
    const params = insertCall![1] as (string | number)[];
    expect(params[11]).toBe("alice"); // name_lower: "Ａｌｉｃｅ".normalize("NFKC").toLowerCase()
    expect(params[16]).toBe("alice"); // directory_name_lower
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
    expect(sql).toContain("WHERE request_key = ?");
    expect(sql).toContain("ORDER BY name_lower ASC");
    expect(sql).toContain("LIMIT ?");
    expect(sql).not.toContain("LIKE");
    expect(sql).not.toContain("OFFSET");
    expect(call![1]).toEqual(["rk1", 50]);
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

  it("UPSERT → 不要行 DELETE の順で実行される", async () => {
    const { replaceGhostsByRequestKey } = await import("./ghostDatabase");
    const ghosts = [
      { name: "A", sakura_name: "", kero_name: "", craftman: "", craftmanw: "", directory_name: "a", path: "/a", source: "ssp", thumbnail_path: "", thumbnail_use_self_alpha: false, thumbnail_kind: "", diff_fingerprint: "fp" },
    ];
    await replaceGhostsByRequestKey("rk1", ghosts);

    const sqlCalls = mockExecute.mock.calls
      .map((c) => c[0] as string)
      .filter((sql) => !sql.startsWith("PRAGMA"));

    expect(sqlCalls[0]).toContain("INSERT INTO ghosts");
    expect(sqlCalls[0]).toContain("ON CONFLICT(request_key, ghost_identity_key)");
    expect(sqlCalls[1]).toMatch(/^DELETE FROM ghosts WHERE request_key = \? AND ghost_identity_key NOT IN/);
  });

  it("ゴーストが空の場合は request_key 単位で全削除される", async () => {
    const { replaceGhostsByRequestKey } = await import("./ghostDatabase");
    await replaceGhostsByRequestKey("rk1", []);

    const sqlCalls = mockExecute.mock.calls
      .map((c) => c[0] as string)
      .filter((sql) => !sql.startsWith("PRAGMA"));

    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0]).toMatch(/^DELETE FROM ghosts/);
  });

  it("同一 row_fingerprint の再投入では UPDATE を抑制する WHERE 条件を含む", async () => {
    const { replaceGhostsByRequestKey } = await import("./ghostDatabase");
    const ghosts = [
      { name: "A", sakura_name: "", kero_name: "", craftman: "", craftmanw: "", directory_name: "a", path: "/a", source: "ssp", thumbnail_path: "", thumbnail_use_self_alpha: false, thumbnail_kind: "", diff_fingerprint: "fp-a" },
    ];
    await replaceGhostsByRequestKey("rk1", ghosts);

    const upsertSql = mockExecute.mock.calls
      .map((c) => c[0] as string)
      .find((sql) => sql.includes("ON CONFLICT(request_key, ghost_identity_key)"));

    expect(upsertSql).toBeDefined();
    expect(upsertSql).toContain("WHERE ghosts.row_fingerprint <> excluded.row_fingerprint");
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

describe("ghostDatabase - setCachedFingerprint", () => {
  it("INSERT OR REPLACE で fingerprint を保存する", async () => {
    const { setCachedFingerprint } = await import("./ghostDatabase");
    await setCachedFingerprint("rk1", "fp-new");

    const call = mockExecute.mock.calls.find((c) =>
      (c[0] as string).includes("ghost_fingerprints")
    );
    expect(call).toBeDefined();
    expect(call![0]).toContain("INSERT OR REPLACE INTO ghost_fingerprints");
    expect(call![0]).toContain("CURRENT_TIMESTAMP");
    expect(call![1]).toEqual(["rk1", "fp-new"]);
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
    await cleanupOldGhostCaches("rk-current", 2, 30);

    const ghostsDeleteCall = mockExecute.mock.calls.find((c) =>
      (c[0] as string).startsWith("DELETE FROM ghosts WHERE request_key IN")
    );
    expect(ghostsDeleteCall).toBeDefined();
    expect(ghostsDeleteCall![1]).toEqual(["rk-old"]);

    const fpDeleteCall = mockExecute.mock.calls.find((c) =>
      (c[0] as string).startsWith("DELETE FROM ghost_fingerprints WHERE request_key IN")
    );
    expect(fpDeleteCall).toBeDefined();
    expect(fpDeleteCall![1]).toEqual(["rk-old"]);
  });

  it("currentRequestKey が DB に存在しない場合でも戻り値に含まれる", async () => {
    mockSelect.mockResolvedValue([
      { request_key: "rk-other", last_updated: new Date().toISOString() },
    ]);

    const { cleanupOldGhostCaches } = await import("./ghostDatabase");
    await cleanupOldGhostCaches("rk-new", 5, 30);

    // rk-other は世代内なので DELETE されない
    const deleteCall = mockExecute.mock.calls.find((c) =>
      (c[0] as string).startsWith("DELETE FROM ghosts WHERE request_key IN")
    );
    expect(deleteCall).toBeUndefined();
  });

  it("全エントリが TTL 切れでも currentRequestKey のみ保持される（バグ修正リグレッション）", async () => {
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    mockSelect.mockResolvedValue([
      { request_key: "rk-current", last_updated: iso(40) },
      { request_key: "rk-stale", last_updated: iso(40) },
    ]);

    const { cleanupOldGhostCaches } = await import("./ghostDatabase");
    await cleanupOldGhostCaches("rk-current", 5, 30);

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
    await cleanupOldGhostCaches("rk-current", 0, 30);

    const deleteCall = mockExecute.mock.calls.find((c) =>
      (c[0] as string).startsWith("DELETE FROM ghosts WHERE request_key IN")
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall![1]).toEqual(["rk-other"]);
  });
});
