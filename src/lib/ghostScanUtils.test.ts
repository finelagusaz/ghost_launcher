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

  // Rust 側（scan.rs の String::cmp）とソート順を一致させる不変条件。
  // localeCompare では '_'(0x5F) が '2'(0x32) より前に来てしまい、
  // ghost_dev が ghost2 より前にソートされ request_key が Rust と食い違う。
  // コードポイント順では '2' < '_' なので ghost2 が先でなければならない。
  it("コードポイント順でソートする（ghost2 が ghost_dev より前）", () => {
    const result = buildAdditionalFolders([
      "C:\\g\\ghost_dev",
      "C:\\g\\ghost2",
      "C:\\g\\ghost",
    ]);
    expect(result).toEqual(["C:\\g\\ghost", "C:\\g\\ghost2", "C:\\g\\ghost_dev"]);
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
