import { describe, it, expect, vi, beforeEach } from "vitest";
import { refreshGhostCatalog } from "./ghostCatalogService";
import { cleanupOldGhostCaches, hasGhosts, replaceGhostsByRequestKey } from "./ghostDatabase";
import { getCachedFingerprint, pruneFingerprintCache, setCachedFingerprint } from "./fingerprintCache";
import { executeScan } from "./ghostScanOrchestrator";

vi.mock("./ghostDatabase", () => ({
  hasGhosts: vi.fn(),
  replaceGhostsByRequestKey: vi.fn(),
  cleanupOldGhostCaches: vi.fn(),
}));

vi.mock("./fingerprintCache", () => ({
  getCachedFingerprint: vi.fn(),
  setCachedFingerprint: vi.fn(),
  pruneFingerprintCache: vi.fn(),
}));

vi.mock("./ghostScanOrchestrator", () => ({
  executeScan: vi.fn(),
}));

describe("refreshGhostCatalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(cleanupOldGhostCaches).mockResolvedValue([]);
  });

  it("キャッシュが有効ならスキャンをスキップする", async () => {
    vi.mocked(getCachedFingerprint).mockReturnValue("fp1");
    vi.mocked(hasGhosts).mockResolvedValue(true);
    vi.mocked(executeScan).mockResolvedValue({ ghosts: [], fingerprint: "fp1" });

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
    vi.mocked(getCachedFingerprint).mockReturnValue("fp1");
    vi.mocked(hasGhosts).mockResolvedValue(true);
    vi.mocked(executeScan).mockResolvedValue({
      ghosts: [
        { name: "A", craftman: "", directory_name: "a", path: "/a", source: "ssp", thumbnail_path: "", thumbnail_use_self_alpha: false, thumbnail_kind: "", diff_fingerprint: "fp-row" },
      ],
      fingerprint: "fp2",
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

  it("キャッシュ fingerprint 一致でも DB に ghost が無ければ保存する", async () => {
    vi.mocked(getCachedFingerprint).mockReturnValue("fp1");
    vi.mocked(hasGhosts).mockResolvedValue(false);
    vi.mocked(executeScan).mockResolvedValue({
      ghosts: [{ name: "B", craftman: "", directory_name: "b", path: "/b", source: "ssp" }],
      fingerprint: "fp1",
    });

    const result = await refreshGhostCatalog({
      sspPath: "C:/SSP",
      ghostFolders: [],
      forceFullScan: false,
    });

    expect(result.skipped).toBe(false);
    expect(replaceGhostsByRequestKey).toHaveBeenCalledTimes(1);
  });

  it("forceFullScan のときはキャッシュ判定を行わずスキャンする", async () => {
    vi.mocked(executeScan).mockResolvedValue({ ghosts: [], fingerprint: "fp3" });

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
    });
  });

  it("保存後に古い request_key と fingerprint キャッシュを掃除する", async () => {
    vi.mocked(executeScan).mockResolvedValue({ ghosts: [], fingerprint: "fp3" });
    vi.mocked(cleanupOldGhostCaches).mockResolvedValue(["rk-current"]);

    await refreshGhostCatalog({
      sspPath: "C:/SSP",
      ghostFolders: [],
      forceFullScan: true,
    });

    expect(cleanupOldGhostCaches).toHaveBeenCalledTimes(1);
    expect(cleanupOldGhostCaches).toHaveBeenCalledWith("c:/ssp::");
    expect(pruneFingerprintCache).toHaveBeenCalledWith(["rk-current"]);
  });
});
