import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import ja from "../locales/ja.json";
import en from "../locales/en.json";
import zhCN from "../locales/zh-CN.json";
import zhTW from "../locales/zh-TW.json";
import ko from "../locales/ko.json";
import ru from "../locales/ru.json";

export const SUPPORTED_LANGUAGES = ["ja", "en", "zh-CN", "zh-TW", "ko", "ru"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const LANGUAGE_STORE_KEY = "language";

export function isSupportedLanguage(value: string): value is Language {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

function detectOsLanguage(): Language {
  const full = navigator.language;        // "zh-TW", "ko-KR" など
  const base = full.split("-")[0];        // "zh", "ko" など

  // 完全一致を優先（zh-TW, zh-CN など）
  if (isSupportedLanguage(full)) return full;
  // 基本言語コードで一致（ko-KR → ko など）
  if (isSupportedLanguage(base)) return base;
  // zh 単体は簡体字にフォールバック
  if (base === "zh") return "zh-CN";
  return "en";
}

// バンドルリソースを使う同期初期化（initImmediate: false で同期完了を保証）
i18n.use(initReactI18next).init({
  resources: {
    ja: { translation: ja },
    en: { translation: en },
    "zh-CN": { translation: zhCN },
    "zh-TW": { translation: zhTW },
    ko: { translation: ko },
    ru: { translation: ru },
  },
  lng: detectOsLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: true },
  initImmediate: false,
});

/** JSON 文字列を検証し、文字列値のみを抽出する。非文字列値は無視する */
function extractStringValues(json: string): Record<string, string> {
  const data: unknown = JSON.parse(json);
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("言語ファイルはオブジェクト形式である必要があります");
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value === "string") {
      result[key] = value;
    }
    // 非文字列値は無視（悪意あるコードの混入対策）
  }
  return result;
}

/**
 * 実行ファイル横の locales/{lang}.json を読み込み、バンドル翻訳にキー単位でマージする。
 * ファイルが存在しない場合・エラー時はスキップ（バンドル翻訳のまま続行）。
 */
export async function applyUserLocale(lang: Language): Promise<void> {
  try {
    const content = await invoke<string | null>("read_user_locale", { lang });
    if (typeof content !== "string") return;
    const userResources = extractStringValues(content);
    i18n.addResources(lang, "translation", userResources);
  } catch (err) {
    console.warn("[i18n] ユーザー言語ファイルの読み込みをスキップしました:", err);
  }
}

export { i18n, extractStringValues, detectOsLanguage };
