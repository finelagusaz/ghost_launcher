import { describe, it, expect, vi, beforeEach } from "vitest";
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

// useGhosts / useSearch の戻り値はテストごとに差し替える。GhostContent が受け取る
// props を捕捉し、App の合成ロジック（requestKey ゲート・エラー抑制）を検証する
const mocks = vi.hoisted(() => ({
  ghostsState: { loading: true, error: null as string | null, refresh: () => {} },
  searchState: {
    ghosts: [] as unknown[],
    total: 0,
    loadedStart: 0,
    loading: false,
    dbError: null as string | null,
  },
  useSearchSpy: vi.fn(),
  ghostContentSpy: vi.fn(),
}));

vi.mock("./hooks/useGhosts", () => ({
  useGhosts: () => mocks.ghostsState,
}));
vi.mock("./hooks/useSearch", () => ({
  useSearch: (...args: unknown[]) => {
    mocks.useSearchSpy(...args);
    return mocks.searchState;
  },
}));
vi.mock("./components/GhostContent", () => ({
  GhostContent: (props: Record<string, unknown>) => {
    mocks.ghostContentSpy(props);
    return null;
  },
}));
// plugin-sql のロードを避けるため DB アクセス関数はモック化する
vi.mock("./lib/ghostDatabase", () => ({
  getRandomGhost: vi.fn(),
  recordLaunch: vi.fn(),
}));

import App from "./App";

function makeGhost(name: string) {
  return {
    name,
    directory_name: name.toLowerCase(),
    path: `/${name}`,
    source: "ssp",
    name_lower: name.toLowerCase(),
    directory_name_lower: name.toLowerCase(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ghostsState = { loading: true, error: null, refresh: () => {} };
  mocks.searchState = { ghosts: [], total: 0, loadedStart: 0, loading: false, dbError: null };
});

describe("App - 起動時のキャッシュ即時表示", () => {
  it("初回スキャン中（ghostsLoading=true）でも sspPath が確定していればキャッシュを即時クエリする", () => {
    mocks.ghostsState = { loading: true, error: null, refresh: () => {} };

    render(<App />);

    // useSearch の第1引数 requestKey が非 null = スキャン完了を待たずに DB を引く
    const lastCall = mocks.useSearchSpy.mock.calls.at(-1);
    expect(lastCall?.[0]).not.toBeNull();
    expect(typeof lastCall?.[0]).toBe("string");
  });
});

describe("App - スキャンエラー時のキャッシュ保持（SPEC 9 エラーハンドリング）", () => {
  it("キャッシュ表示中（ゴーストあり）はスキャンエラーを抑制する", () => {
    mocks.ghostsState = { loading: false, error: "scan failed", refresh: () => {} };
    mocks.searchState = {
      ghosts: [makeGhost("Reimu"), makeGhost("Marisa")],
      total: 2,
      loadedStart: 0,
      loading: false,
      dbError: null,
    };

    render(<App />);

    const props = mocks.ghostContentSpy.mock.calls.at(-1)?.[0];
    expect(props?.error).toBeNull();
  });

  it("キャッシュなし（ゴースト空）ではスキャンエラーを表示する", () => {
    mocks.ghostsState = { loading: false, error: "scan failed", refresh: () => {} };
    mocks.searchState = { ghosts: [], total: 0, loadedStart: 0, loading: false, dbError: null };

    render(<App />);

    const props = mocks.ghostContentSpy.mock.calls.at(-1)?.[0];
    expect(props?.error).toBe("scan failed");
  });
});
