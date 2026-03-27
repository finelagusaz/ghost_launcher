import { describe, it, expect, vi, beforeEach } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

async function loadModule() {
  return await import("./dbMonitor");
}

describe("dbMonitor - recordSearchLatency / getP95SearchLatency", () => {
  it("空のバッファは null を返す", async () => {
    const { getP95SearchLatency } = await loadModule();
    expect(getP95SearchLatency()).toBeNull();
  });

  it("1件のみの場合は p95 = その値", async () => {
    const { recordSearchLatency, getP95SearchLatency } = await loadModule();
    recordSearchLatency(42);
    expect(getP95SearchLatency()).toBe(42);
  });

  it("100件のデータで p95 を正しく計算する", async () => {
    const { recordSearchLatency, getP95SearchLatency } = await loadModule();
    // 1, 2, 3, ..., 100 を投入 → p95 = 95番目 = 95
    for (let i = 1; i <= 100; i++) {
      recordSearchLatency(i);
    }
    expect(getP95SearchLatency()).toBe(95);
  });

  it("101件目で先頭を押し出す（リングバッファ上限 100）", async () => {
    const { recordSearchLatency, getP95SearchLatency } = await loadModule();
    // 100件の 10ms を投入
    for (let i = 0; i < 100; i++) {
      recordSearchLatency(10);
    }
    // 101件目に 9999ms を投入 → 先頭の 10ms が押し出される
    recordSearchLatency(9999);
    // バッファ: 10ms x 99 + 9999ms x 1（100件）。sorted[94] = 10（10ms が 99 個）
    expect(getP95SearchLatency()).toBe(10);

    // 5件追加で 9999ms を入れる → バッファ: 10ms x 94 + 9999ms x 6
    for (let i = 0; i < 5; i++) {
      recordSearchLatency(9999);
    }
    // sorted = [10x94, 9999x6]。sorted[94] = 9999（10ms は 94 個で index 0-93）
    expect(getP95SearchLatency()).toBe(9999);
  });
});

describe("dbMonitor - measureSearch", () => {
  it("fn の戻り値をそのまま返す", async () => {
    const { measureSearch } = await loadModule();
    const result = await measureSearch("searchGhosts", async () => "hello");
    expect(result).toBe("hello");
  });

  it("[dbMonitor] プレフィックスの JSON を console.log に出力する", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { measureSearch } = await loadModule();
    await measureSearch("searchGhosts", async () => null);
    const monitorLog = spy.mock.calls.find((c) => (c[0] as string).startsWith("[dbMonitor]"));
    expect(monitorLog).toBeDefined();
    const json = JSON.parse((monitorLog![0] as string).replace("[dbMonitor] ", ""));
    expect(json.event).toBe("search_latency");
    expect(json.label).toBe("searchGhosts");
    expect(typeof json.duration_ms).toBe("number");
  });

  it("p95 が閾値を超えたとき console.warn を呼ぶ", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { measureSearch, recordSearchLatency } = await loadModule();
    // p95 を 400ms にするため、バッファに 400ms を詰める
    for (let i = 0; i < 99; i++) {
      recordSearchLatency(400);
    }
    await measureSearch("searchGhosts", async () => null);
    const alertCall = warnSpy.mock.calls.find((c) =>
      (c[0] as string).includes("search_p95_exceeded"),
    );
    expect(alertCall).toBeDefined();
  });

  it("fn が throw した場合、例外を再スローする", async () => {
    const { measureSearch } = await loadModule();
    await expect(
      measureSearch("searchGhosts", async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");
  });

  it("p95 が閾値以下のとき console.warn を呼ばない", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { measureSearch } = await loadModule();
    await measureSearch("searchGhosts", async () => null);
    const alertCall = warnSpy.mock.calls.find((c) =>
      (c[0] as string).includes("search_p95_exceeded"),
    );
    expect(alertCall).toBeUndefined();
  });
});

describe("dbMonitor - reportScanComplete", () => {
  it("scan_complete イベントを JSON で console.log に出力する", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { reportScanComplete } = await loadModule();
    reportScanComplete(
      { cache_hit: false, total: 500, fingerprint: "fp", request_key: "rk" },
      1234,
    );
    const logCall = spy.mock.calls.find((c) =>
      (c[0] as string).includes("scan_complete"),
    );
    expect(logCall).toBeDefined();
    const json = JSON.parse((logCall![0] as string).replace("[dbMonitor] ", ""));
    expect(json.total).toBe(500);
    expect(json.duration_ms).toBe(1234);
    expect(json.request_key).toBe("rk");
  });

  it("total が 100,000 を超えたとき console.warn を呼ぶ", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { reportScanComplete } = await loadModule();
    reportScanComplete(
      { cache_hit: false, total: 100_001, fingerprint: "fp", request_key: "rk" },
      100,
    );
    const alertCall = warnSpy.mock.calls.find((c) =>
      (c[0] as string).includes("ghost_count_exceeded"),
    );
    expect(alertCall).toBeDefined();
  });

  it("total が 100,000 以下のとき console.warn を呼ばない", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { reportScanComplete } = await loadModule();
    reportScanComplete(
      { cache_hit: false, total: 100_000, fingerprint: "fp", request_key: "rk" },
      100,
    );
    const alertCall = warnSpy.mock.calls.find((c) =>
      (c[0] as string).includes("ghost_count_exceeded"),
    );
    expect(alertCall).toBeUndefined();
  });
});

describe("dbMonitor - reportDbSize", () => {
  it("page_count * page_size を size_bytes として出力する", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { reportDbSize } = await loadModule();
    const fakeDb = {
      select: vi.fn()
        .mockResolvedValueOnce([{ page_count: 256 }])
        .mockResolvedValueOnce([{ page_size: 4096 }]),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportDbSize(fakeDb as any, "startup");
    const logCall = spy.mock.calls.find((c) =>
      (c[0] as string).includes("db_size"),
    );
    expect(logCall).toBeDefined();
    const json = JSON.parse((logCall![0] as string).replace("[dbMonitor] ", ""));
    expect(json.size_bytes).toBe(256 * 4096);
    expect(json.trigger).toBe("startup");
  });

  it("size_bytes が 100MB を超えたとき console.warn を呼ぶ", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { reportDbSize } = await loadModule();
    const pages = Math.ceil((100 * 1024 * 1024 + 1) / 4096);
    const fakeDb = {
      select: vi.fn()
        .mockResolvedValueOnce([{ page_count: pages }])
        .mockResolvedValueOnce([{ page_size: 4096 }]),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportDbSize(fakeDb as any, "scan_complete");
    const alertCall = warnSpy.mock.calls.find((c) =>
      (c[0] as string).includes("db_size_exceeded"),
    );
    expect(alertCall).toBeDefined();
  });

  it("DB アクセスが失敗しても例外を throw しない", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { reportDbSize } = await loadModule();
    const fakeDb = {
      select: vi.fn().mockRejectedValue(new Error("DB error")),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(reportDbSize(fakeDb as any, "startup")).resolves.toBeUndefined();
  });
});
