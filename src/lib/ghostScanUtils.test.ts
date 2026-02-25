import { describe, it, expect } from "vitest";
import { normalizePathKey, buildAdditionalFolders, buildRequestKey } from "./ghostScanUtils";

describe("normalizePathKey", () => {
  it("バックスラッシュをスラッシュに変換する", () => {
    expect(normalizePathKey("C:\\SSP")).toBe("c:/ssp");
  });
  it("末尾スラッシュを除去する（ドライブルート除く）", () => {
    expect(normalizePathKey("C:/SSP/")).toBe("c:/ssp");
  });
  it("ドライブルートの末尾スラッシュを維持する", () => {
    expect(normalizePathKey("C:/")).toBe("c:/");
  });
});

describe("buildAdditionalFolders", () => {
  it("正規化パスで重複排除してソートする", () => {
    const result = buildAdditionalFolders([
      "C:\\Ghosts\\Extra",
      "c:/ghosts/extra",
      "C:/Ghosts/Another",
    ]);
    expect(result).toHaveLength(2);
  });
});

describe("buildRequestKey", () => {
  it("SSP パスと追加フォルダから requestKey を生成する", () => {
    const key = buildRequestKey("C:\\SSP", ["C:\\Ghosts"]);
    expect(key).toBe("c:/ssp::c:/ghosts");
  });
  it("追加フォルダなしの場合も正しく生成する", () => {
    const key = buildRequestKey("C:/SSP", []);
    expect(key).toBe("c:/ssp::");
  });
});
