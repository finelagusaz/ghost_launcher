import { describe, it, expect } from "vitest";
import { i18n, SUPPORTED_LANGUAGES, LANGUAGE_STORE_KEY } from "./i18n";
import ja from "../locales/ja.json";
import en from "../locales/en.json";

describe("i18n", () => {
  it("SUPPORTED_LANGUAGES に ja と en が含まれる", () => {
    expect(SUPPORTED_LANGUAGES).toContain("ja");
    expect(SUPPORTED_LANGUAGES).toContain("en");
  });

  it("LANGUAGE_STORE_KEY が定義されている", () => {
    expect(LANGUAGE_STORE_KEY).toBe("language");
  });

  it("日本語リソースが全キーを持つ", () => {
    const keys = Object.keys(ja);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toContain("app.loading");
    expect(keys).toContain("card.launch");
    expect(keys).toContain("search.label");
  });

  it("英語リソースが全キーを持つ", () => {
    const keys = Object.keys(en);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toContain("app.loading");
    expect(keys).toContain("card.launch");
    expect(keys).toContain("search.label");
  });

  it("ja に切り替えると日本語が返る", async () => {
    await i18n.changeLanguage("ja");
    expect(i18n.t("card.launch")).toBe("起動");
    expect(i18n.t("list.empty")).toBe("ゴーストが見つかりません");
  });

  it("en に切り替えると英語が返る", async () => {
    await i18n.changeLanguage("en");
    expect(i18n.t("card.launch")).toBe("Launch");
    expect(i18n.t("list.empty")).toBe("No ghosts found");
  });

  it("list.count の補間が正しく動作する", async () => {
    await i18n.changeLanguage("ja");
    expect(i18n.t("list.count", { count: 42 })).toBe("42 体のゴースト");

    await i18n.changeLanguage("en");
    expect(i18n.t("list.count", { count: 1 })).toBe("1 ghost");
    expect(i18n.t("list.count", { count: 5 })).toBe("5 ghosts");
  });

  it("card.launchError の補間が正しく動作する", async () => {
    await i18n.changeLanguage("ja");
    const msg = i18n.t("card.launchError", { detail: " (error)" });
    expect(msg).toContain("起動に失敗しました");
    expect(msg).toContain(" (error)");
  });
});
