import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ja from "../locales/ja.json";
import en from "../locales/en.json";

export const SUPPORTED_LANGUAGES = ["ja", "en"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const LANGUAGE_STORE_KEY = "language";

function detectOsLanguage(): Language {
  const lang = navigator.language.split("-")[0];
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(lang)
    ? (lang as Language)
    : "en";
}

// バンドルリソースを使う同期初期化（initImmediate: false で同期完了を保証）
i18n.use(initReactI18next).init({
  resources: {
    ja: { translation: ja },
    en: { translation: en },
  },
  lng: detectOsLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: true },
  initImmediate: false,
});

export { i18n };
