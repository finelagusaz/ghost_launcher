import { describe, it, expect, vi, beforeEach } from "vitest";
import { refreshGhostCatalog } from "./ghostCatalogService";
import { cleanupOldGhostCaches, getCachedFingerprint, hasGhosts, replaceGhostsByRequestKey, setCachedFingerprint } from "./ghostDatabase";
import { executeScan } from "./ghostScanOrchestrator";

vi.mock("./ghostDatabase", () => ({
  hasGhosts: vi.fn(),
  replaceGhostsByRequestKey: vi.fn(),
  cleanupOldGhostCaches: vi.fn(),
  getCachedFingerprint: vi.fn(),
  setCachedFingerprint: vi.fn(),
}));

vi.mock("./ghostScanOrchestrator", () => ({
  executeScan: vi.fn(),
}));

describe("refreshGhostCatalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(setCachedFingerprint).mockResolvedValue(undefined);
    vi.mocked(cleanupOldGhostCaches).mockResolvedValue(undefined);
  });

  it("キャッシュが有効ならスキャンをスキップする", async () => {
    vi.mocked(getCachedFingerprint).mockResolvedValue("fp1");
    vi.mocked(hasGhosts).mockResolvedValue(true);
    vi.mocked(executeScan).mockResolvedValue({ ghosts: [], fingerprint: "fp1", cache_hit: true });

    const result = await refreshGhostCatalog({
      sspPath: "C:/SSP",
      ghostFolders: ["C:/Ghosts"],
      forceFullScan: false,
    });

    expect(result.skipped).toBe(true);
    expect(executeScan).toHaveBeenCalledTimes(1);
    expect(replaceGhostsByRequestKey).not.toHaveBeenCalled();
  });

  it("キャッシュが無効ならスキャンして保存する", async () => {
    vi.mocked(getCachedFingerprint).mockResolvedValue("fp1");
    vi.mocked(hasGhosts).mockResolvedValue(true);
    vi.mocked(executeScan).mockResolvedValue({
      ghosts: [
        { name: "A", craftman: "", directory_name: "a", path: "/a", source: "ssp", thumbnail_path: "", thumbnail_use_self_alpha: false, thumbnail_kind: "", diff_fingerprint: "fp-row", sakura_name: "", kero_name: "", craftmanw: "" },
      ],
      fingerprint: "fp2",
      cache_hit: false,
    });

    const result = await refreshGhostCatalog({
      sspPath: "C:/SSP",
      ghostFolders: ["C:/Ghosts"],
      forceFullScan: false,
    });

    expect(result.skipped).toBe(false);
    expect(executeScan).toHaveBeenCalledTimes(1);
    expect(replaceGhostsByRequestKey).toHaveBeenCalledTimes(1);
    expect(setCachedFingerprint).toHaveBeenCalledTimes(1);
  });

  it("DB に ghost が無ければ cachedFingerprint=null でフルスキャンして保存する", async () => {
    vi.mocked(getCachedFingerprint).mockResolvedValue("fp1");
    vi.mocked(hasGhosts).mockResolvedValue(false);
    vi.mocked(executeScan).mockResolvedValue({
      ghosts: [{ name: "B", craftman: "", directory_name: "b", path: "/b", source: "ssp", sakura_name: "", kero_name: "", craftmanw: "", thumbnail_path: "", thumbnail_use_self_alpha: false, thumbnail_kind: "" }],
      fingerprint: "fp1",
      cache_hit: false,
    });

    const result = await refreshGhostCatalog({
      sspPath: "C:/SSP",
      ghostFolders: [],
      forceFullScan: false,
    });

    expect(result.skipped).toBe(false);
    expect(executeScan).toHaveBeenCalledWith(
      expect.objectContaining({ cachedFingerprint: null }),
    );
    expect(replaceGhostsByRequestKey).toHaveBeenCalledTimes(1);
  });

  it("forceFullScan のときはキャッシュ判定を行わずスキャンする", async () => {
    vi.mocked(executeScan).mockResolvedValue({ ghosts: [], fingerprint: "fp3", cache_hit: false });

    await refreshGhostCatalog({
      sspPath: "C:/SSP",
      ghostFolders: [],
      forceFullScan: true,
    });

    expect(getCachedFingerprint).not.toHaveBeenCalled();
    expect(hasGhosts).not.toHaveBeenCalled();
    expect(executeScan).toHaveBeenCalledTimes(1);
    expect(executeScan).toHaveBeenCalledWith({
      requestKey: "c:/ssp::",
      sspPath: "C:/SSP",
      additionalFolders: [],
      forceFullScan: true,
      cachedFingerprint: null,
    });
  });

  it("保存後に古い request_key と fingerprint キャッシュを掃除する", async () => {
    vi.mocked(executeScan).mockResolvedValue({ ghosts: [], fingerprint: "fp3", cache_hit: false });
    vi.mocked(cleanupOldGhostCaches).mockResolvedValue(undefined);

    await refreshGhostCatalog({
      sspPath: "C:/SSP",
      ghostFolders: [],
      forceFullScan: true,
    });

    expect(cleanupOldGhostCaches).toHaveBeenCalledTimes(1);
    expect(cleanupOldGhostCaches).toHaveBeenCalledWith("c:/ssp::");
  });

  // --- 新規テスト（RED）---

  it("executeScan に cachedFingerprint が渡される", async () => {
    vi.mocked(getCachedFingerprint).mockResolvedValue("fp-cached");
    vi.mocked(executeScan).mockResolvedValue({ ghosts: [], fingerprint: "fp-cached", cache_hit: true });
    vi.mocked(hasGhosts).mockResolvedValue(true);

    await refreshGhostCatalog({
      sspPath: "C:/SSP",
      ghostFolders: [],
      forceFullScan: false,
    });

    expect(executeScan).toHaveBeenCalledWith(
      expect.objectContaining({ cachedFingerprint: "fp-cached" }),
    );
  });

  it("forceFullScan のとき cachedFingerprint=null が executeScan に渡される", async () => {
    vi.mocked(executeScan).mockResolvedValue({ ghosts: [], fingerprint: "fp3", cache_hit: false });

    await refreshGhostCatalog({
      sspPath: "C:/SSP",
      ghostFolders: [],
      forceFullScan: true,
    });

    expect(executeScan).toHaveBeenCalledWith(
      expect.objectContaining({ cachedFingerprint: null }),
    );
  });

  it("cache_hit=true のとき replaceGhostsByRequestKey が呼ばれない", async () => {
    vi.mocked(getCachedFingerprint).mockResolvedValue("fp1");
    vi.mocked(executeScan).mockResolvedValue({ ghosts: [], fingerprint: "fp1", cache_hit: true });
    vi.mocked(hasGhosts).mockResolvedValue(true);

    const result = await refreshGhostCatalog({
      sspPath: "C:/SSP",
      ghostFolders: [],
      forceFullScan: false,
    });

    expect(result.skipped).toBe(true);
    expect(replaceGhostsByRequestKey).not.toHaveBeenCalled();
  });
});
