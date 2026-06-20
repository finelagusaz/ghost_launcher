import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // lib/i18n.ts が読込時に i18n.use(initReactI18next) を呼ぶためスタブを供給する
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

// 設定読込は完了済み・sspPath は確定している状態
vi.mock("./hooks/useSettings", () => ({
  useSettings: () => ({
    sspPath: "C:/SSP",
    saveSspPath: vi.fn(),
    ghostFolders: [],
    addGhostFolder: vi.fn(),
    removeGhostFolder: vi.fn(),
    language: "ja",
    saveLanguage: vi.fn(),
    loading: false,
    languageApplying: false,
  }),
}));

// 初回スキャンが進行中（ghostsLoading=true のまま）= キャッシュ未活用バグの再現条件
vi.mock("./hooks/useGhosts", () => ({
  useGhosts: () => ({ loading: true, error: null, refresh: vi.fn() }),
}));

// useSearch の呼び出し引数（特に requestKey）を捕捉する
const { useSearchSpy } = vi.hoisted(() => ({
  useSearchSpy: vi.fn(() => ({
    ghosts: [],
    total: 0,
    loadedStart: 0,
    loading: false,
    dbError: null,
  })),
}));
vi.mock("./hooks/useSearch", () => ({
  useSearch: useSearchSpy,
}));

// plugin-sql のロードを避けるため DB アクセス関数はモック化する
vi.mock("./lib/ghostDatabase", () => ({
  getRandomGhost: vi.fn(),
  recordLaunch: vi.fn(),
}));

import App from "./App";

describe("App - 起動時のキャッシュ即時表示", () => {
  it("初回スキャン中（ghostsLoading=true）でも sspPath が確定していればキャッシュを即時クエリする", () => {
    render(<App />);

    // useSearch の第1引数 requestKey が非 null = スキャン完了を待たずに DB を引く
    const lastCall = useSearchSpy.mock.calls.at(-1);
    expect(lastCall?.[0]).not.toBeNull();
    expect(typeof lastCall?.[0]).toBe("string");
  });
});
