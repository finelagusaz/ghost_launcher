import { describe, it, expect, beforeEach } from "vitest";
import { i18n, SUPPORTED_LANGUAGES } from "./i18n";
import { describeError, formatErrorDetail, buildScanErrorMessage } from "./errorMessages";
import type { CommandError } from "../types/generated/CommandError";

// i18n.t は言語切替に追従する。テストごとに言語を明示して始める
const t = i18n.t.bind(i18n);
const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

describe("describeError", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("種別つきのコマンドエラーを UI の言語の文言にする", () => {
    const error: CommandError = { kind: "sspExeNotFound", path: "C:\\SSP\\ssp.exe" };
    const message = describeError(error, t);
    expect(message).toContain("C:\\SSP\\ssp.exe");
    expect(message).not.toMatch(JAPANESE);
  });

  it("種別の文言は言語の切替に追従する", async () => {
    const error: CommandError = { kind: "ghostFolderNotFound", path: "C:/SSP/ghost" };
    const en = describeError(error, t);
    await i18n.changeLanguage("ja");
    const ja = describeError(error, t);
    expect(ja).not.toBe(en);
    expect(ja).toMatch(JAPANESE);
  });

  it("internal は詳細をそのまま返す", () => {
    expect(describeError({ kind: "internal", detail: "database is locked" }, t)).toBe(
      "database is locked",
    );
  });

  it("Error は message、それ以外は文字列化した値を返す", () => {
    expect(describeError(new Error("boom"), t)).toBe("boom");
    expect(describeError("plain", t)).toBe("plain");
  });
});

describe("formatErrorDetail", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("詳細を UI の言語の括弧書きで包む", () => {
    const detail = formatErrorDetail(new Error("boom"), t);
    expect(detail).toContain("boom");
    expect(detail).not.toMatch(JAPANESE);
  });

  it("詳細が空なら空文字を返す", () => {
    expect(formatErrorDetail(new Error("  "), t)).toBe("");
  });
});

describe("buildScanErrorMessage", () => {
  it.each(SUPPORTED_LANGUAGES)("%s: 再読込ボタンの名前と詳細を含む", async (lang) => {
    await i18n.changeLanguage(lang);
    const message = buildScanErrorMessage(new Error("boom"), t);
    expect(message).toContain(t("header.refresh"));
    expect(message).toContain("boom");
    if (lang !== "ja" && !lang.startsWith("zh")) {
      expect(message).not.toMatch(JAPANESE);
    }
  });

  it("種別つきのエラーは詳細欄も翻訳する", async () => {
    await i18n.changeLanguage("en");
    const message = buildScanErrorMessage(
      { kind: "ghostFolderNotFound", path: "C:/SSP/ghost" } satisfies CommandError,
      t,
    );
    expect(message).toContain("C:/SSP/ghost");
    expect(message).not.toMatch(JAPANESE);
  });
});
