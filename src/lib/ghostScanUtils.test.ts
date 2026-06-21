import { describe, it, expect } from "vitest";
import { normalizePathKey, buildAdditionalFolders, buildRequestKey, requestKeyFromSettings } from "./ghostScanUtils";

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

  // request_key は JS 単一権威（Lv1）。ソートはロケール非依存の決定性が要件。
  // localeCompare では '_'(0x5F) が '2'(0x32) より前に来て環境差を生むため使わない。
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

describe("requestKeyFromSettings", () => {
  it("buildRequestKey(sspPath, buildAdditionalFolders(folders)) と等価", () => {
    const folders = ["C:\\g\\b", "C:\\g\\a"];
    expect(requestKeyFromSettings("C:\\SSP", folders)).toBe(
      buildRequestKey("C:\\SSP", buildAdditionalFolders(folders)),
    );
  });

  // NFKC を適用しない不変条件: 半角カナ ｱ(U+FF71) を全角 ア(U+30A2) へ畳まない。
  // 畳むと別フォルダを同一視してしまう。
  it("NFKC を適用せず半角カナをそのまま保持する", () => {
    expect(requestKeyFromSettings("C:\\SSP", ["C:\\g\\ｱ"])).toBe("c:/ssp::c:/g/ｱ");
  });
});
