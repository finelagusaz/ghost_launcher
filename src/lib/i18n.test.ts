import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { i18n, SUPPORTED_LANGUAGES, LANGUAGE_STORE_KEY, extractStringValues, applyUserLocale } from "./i18n";
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

describe("extractStringValues", () => {
  it("文字列値のみを抽出する", () => {
    const json = JSON.stringify({
      "card.launch": "起動",
      "card.count": 42,
      "card.flag": true,
      "card.obj": { nested: "value" },
    });
    const result = extractStringValues(json);
    expect(result).toEqual({ "card.launch": "起動" });
  });

  it("オブジェクトでない場合はエラーを投げる", () => {
    expect(() => extractStringValues('"string"')).toThrow();
    expect(() => extractStringValues("[1,2,3]")).toThrow();
    expect(() => extractStringValues("null")).toThrow();
  });

  it("空オブジェクトは空 Record を返す", () => {
    expect(extractStringValues("{}")).toEqual({});
  });
});

describe("applyUserLocale", () => {
  beforeEach(async () => {
    vi.mocked(invoke).mockReset();
    // テストの独立性のため ja に固定
    await i18n.changeLanguage("ja");
    // バンドル翻訳を元に戻す
    i18n.addResources("ja", "translation", { "card.launch": "起動" });
  });

  it("ファイルが存在しない場合（null）はバンドル翻訳を維持する", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await applyUserLocale("ja");
    expect(i18n.t("card.launch")).toBe("起動");
  });

  it("ユーザーファイルの文字列値がバンドル翻訳を上書きする", async () => {
    vi.mocked(invoke).mockResolvedValue(JSON.stringify({ "card.launch": "Launch Now" }));
    await applyUserLocale("ja");
    expect(i18n.t("card.launch")).toBe("Launch Now");
    // 後片付け
    i18n.addResources("ja", "translation", { "card.launch": "起動" });
  });

  it("ユーザーファイルの非文字列値は無視される", async () => {
    vi.mocked(invoke).mockResolvedValue(JSON.stringify({ "card.launch": 999 }));
    await applyUserLocale("ja");
    expect(i18n.t("card.launch")).toBe("起動");
  });

  it("invoke がエラーを投げても例外を伝播しない", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("command not found"));
    await expect(applyUserLocale("ja")).resolves.toBeUndefined();
  });

  it("JSON が不正でも例外を伝播しない", async () => {
    vi.mocked(invoke).mockResolvedValue("not valid json{{{");
    await expect(applyUserLocale("ja")).resolves.toBeUndefined();
  });
});
