import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { i18n, SUPPORTED_LANGUAGES, LANGUAGE_STORE_KEY, extractStringValues, applyUserLocale, detectOsLanguage } from "./i18n";
import ja from "../locales/ja.json";
import en from "../locales/en.json";

describe("i18n", () => {
  it("SUPPORTED_LANGUAGES に全サポート言語が含まれる", () => {
    for (const lang of ["ja", "en", "zh-CN", "zh-TW", "ko", "ru"]) {
      expect(SUPPORTED_LANGUAGES).toContain(lang);
    }
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

  it.each([
    ["ja",    "起動",      "ゴーストが見つかりません"],
    ["en",    "Launch",    "No ghosts found"],
    ["zh-CN", "启动",      "未找到幽灵"],
    ["zh-TW", "啟動",      "找不到幽靈"],
    ["ko",    "실행",      "고스트를 찾을 수 없습니다"],
    ["ru",    "Запустить", "Духи не найдены"],
  ])("%s に切り替えると card.launch と list.empty が正しく返る", async (lang, launch, empty) => {
    await i18n.changeLanguage(lang);
    expect(i18n.t("card.launch")).toBe(launch);
    expect(i18n.t("list.empty")).toBe(empty);
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

describe("detectOsLanguage", () => {
  const originalLanguage = Object.getOwnPropertyDescriptor(navigator, "language");

  afterEach(() => {
    if (originalLanguage?.configurable) {
      Object.defineProperty(navigator, "language", originalLanguage);
    }
  });

  function setNavigatorLanguage(lang: string) {
    Object.defineProperty(navigator, "language", {
      get: () => lang,
      configurable: true,
    });
  }

  it("完全一致: zh-TW → zh-TW", () => {
    setNavigatorLanguage("zh-TW");
    expect(detectOsLanguage()).toBe("zh-TW");
  });

  it("完全一致: zh-CN → zh-CN", () => {
    setNavigatorLanguage("zh-CN");
    expect(detectOsLanguage()).toBe("zh-CN");
  });

  it("基本コード一致: ko-KR → ko", () => {
    setNavigatorLanguage("ko-KR");
    expect(detectOsLanguage()).toBe("ko");
  });

  it("基本コード一致: ru-RU → ru", () => {
    setNavigatorLanguage("ru-RU");
    expect(detectOsLanguage()).toBe("ru");
  });

  it("zh 単体は zh-CN にフォールバック", () => {
    setNavigatorLanguage("zh");
    expect(detectOsLanguage()).toBe("zh-CN");
  });

  it("未対応言語は en にフォールバック", () => {
    setNavigatorLanguage("fr-FR");
    expect(detectOsLanguage()).toBe("en");
  });

  it("ja はそのまま返る", () => {
    setNavigatorLanguage("ja");
    expect(detectOsLanguage()).toBe("ja");
  });

  it("ja-JP → ja", () => {
    setNavigatorLanguage("ja-JP");
    expect(detectOsLanguage()).toBe("ja");
  });
});
