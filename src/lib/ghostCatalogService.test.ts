import { describe, it, expect, vi, beforeEach } from "vitest";
import { refreshGhostCatalog } from "./ghostCatalogService";
import { cleanupOldGhostCaches, getCachedFingerprint, hasGhosts } from "./ghostDatabase";
import { invoke } from "@tauri-apps/api/core";

vi.mock("./ghostDatabase", () => ({
  hasGhosts: vi.fn(),
  cleanupOldGhostCaches: vi.fn(),
  getCachedFingerprint: vi.fn(),
  getDb: vi.fn().mockResolvedValue({ select: vi.fn().mockResolvedValue([]) }),
}));

vi.mock("./dbMonitor", () => ({
  reportScanComplete: vi.fn(),
  reportDbSize: vi.fn().mockResolvedValue(undefined),
}));

describe("refreshGhostCatalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(cleanupOldGhostCaches).mockResolvedValue(undefined);
  });

  it("キャッシュが有効ならスキャンをスキップする", async () => {
    vi.mocked(getCachedFingerprint).mockResolvedValue("fp1");
    vi.mocked(hasGhosts).mockResolvedValue(true);
    vi.mocked(invoke).mockResolvedValue({ cache_hit: true, total: 0, fingerprint: "fp1", request_key: "c:/ssp::" });

    const result = await refreshGhostCatalog({
      sspPath: "C:/SSP",
      ghostFolders: ["C:/Ghosts"],
      forceFullScan: false,
    });

    expect(result.skipped).toBe(true);
    expect(invoke).toHaveBeenCalledWith("scan_and_store", expect.objectContaining({
      cachedFingerprint: "fp1",
    }));
  });

  it("キャッシュが無効なら scan_and_store がDB書き込みまで行う", async () => {
    vi.mocked(getCachedFingerprint).mockResolvedValue("fp1");
    vi.mocked(hasGhosts).mockResolvedValue(true);
    vi.mocked(invoke).mockResolvedValue({ cache_hit: false, total: 1, fingerprint: "fp2", request_key: "c:/ssp::c:/ghosts" });

    const result = await refreshGhostCatalog({
      sspPath: "C:/SSP",
      ghostFolders: ["C:/Ghosts"],
      forceFullScan: false,
    });

    expect(result.skipped).toBe(false);
    expect(invoke).toHaveBeenCalledWith("scan_and_store", expect.anything());
  });

  it("DB に ghost が無ければ cachedFingerprint=null でフルスキャンする", async () => {
    vi.mocked(getCachedFingerprint).mockResolvedValue("fp1");
    vi.mocked(hasGhosts).mockResolvedValue(false);
    vi.mocked(invoke).mockResolvedValue({ cache_hit: false, total: 1, fingerprint: "fp1", request_key: "c:/ssp::" });

    await refreshGhostCatalog({
      sspPath: "C:/SSP",
      ghostFolders: [],
      forceFullScan: false,
    });

    expect(invoke).toHaveBeenCalledWith("scan_and_store", expect.objectContaining({
      cachedFingerprint: null,
    }));
  });

  it("forceFullScan のときはキャッシュ判定を行わず scan_and_store を呼ぶ", async () => {
    vi.mocked(invoke).mockResolvedValue({ cache_hit: false, total: 0, fingerprint: "fp3", request_key: "c:/ssp::" });

    await refreshGhostCatalog({
      sspPath: "C:/SSP",
      ghostFolders: [],
      forceFullScan: true,
    });

    expect(getCachedFingerprint).not.toHaveBeenCalled();
    expect(hasGhosts).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("scan_and_store", {
      sspPath: "C:/SSP",
      additionalFolders: [],
      cachedFingerprint: null,
    });
  });

  it("cache miss 後に古い request_key キャッシュを掃除する", async () => {
    vi.mocked(invoke).mockResolvedValue({ cache_hit: false, total: 0, fingerprint: "fp3", request_key: "c:/ssp::" });

    await refreshGhostCatalog({
      sspPath: "C:/SSP",
      ghostFolders: [],
      forceFullScan: true,
    });

    // fire-and-forget なので await 不要だが、呼ばれたことは確認
    expect(cleanupOldGhostCaches).toHaveBeenCalledWith("c:/ssp::");
  });

  it("cache_hit 時は cleanupOldGhostCaches を呼ばない", async () => {
    vi.mocked(getCachedFingerprint).mockResolvedValue("fp1");
    vi.mocked(hasGhosts).mockResolvedValue(true);
    vi.mocked(invoke).mockResolvedValue({ cache_hit: true, total: 0, fingerprint: "fp1", request_key: "c:/ssp::" });

    await refreshGhostCatalog({
      sspPath: "C:/SSP",
      ghostFolders: [],
      forceFullScan: false,
    });

    expect(cleanupOldGhostCaches).not.toHaveBeenCalled();
  });
});
