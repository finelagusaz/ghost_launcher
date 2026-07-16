import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, screen } from "@testing-library/react";

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
  launchGhostSpy: vi.fn(),
  getRandomGhostSpy: vi.fn(),
  launcherToasts: {
    notifySuccess: vi.fn(),
    notifyError: vi.fn(),
    notifyWarning: vi.fn(),
  },
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
  getRandomGhost: (...args: unknown[]) => mocks.getRandomGhostSpy(...args),
  recordLaunch: vi.fn(),
  reseedRandomSort: vi.fn(),
}));
// ランダム起動の成否をテストごとに制御する
vi.mock("./lib/sspClient", () => ({
  launchGhost: (...args: unknown[]) => mocks.launchGhostSpy(...args),
  validateSspPath: vi.fn(),
}));
// トースト通知はスパイに差し替える（Fluent の Toaster コンテキスト非依存で検証する）
vi.mock("./hooks/useLauncherToasts", () => ({
  useLauncherToasts: () => mocks.launcherToasts,
  TOASTER_ID: "test-toaster",
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

describe("App - ランダム起動のフィードバック（トースト・一覧非破壊）", () => {
  async function invokeRandomLaunch() {
    render(<App />);
    const onRandomLaunch = mocks.ghostContentSpy.mock.calls.at(-1)?.[0]?.onRandomLaunch;
    await act(async () => {
      await onRandomLaunch();
    });
  }

  it("成功時は成功トーストを出し、一覧エラーには混入しない", async () => {
    mocks.ghostsState = { loading: false, error: null, refresh: () => {} };
    mocks.searchState = {
      ghosts: [makeGhost("Reimu")],
      total: 1,
      loadedStart: 0,
      loading: false,
      dbError: null,
    };
    mocks.getRandomGhostSpy.mockResolvedValue(makeGhost("Marisa"));
    mocks.launchGhostSpy.mockResolvedValue(undefined);

    await invokeRandomLaunch();

    expect(mocks.launcherToasts.notifySuccess).toHaveBeenCalledWith("card.launchSuccess");
    expect(mocks.launcherToasts.notifyError).not.toHaveBeenCalled();
    // 起動結果が一覧の error prop に流れ込まない（一覧を破壊しない）
    const after = mocks.ghostContentSpy.mock.calls.at(-1)?.[0];
    expect(after?.error).toBeNull();
  });

  it("失敗時はエラートーストを出し、一覧を破壊しない（error prop は null のまま）", async () => {
    mocks.ghostsState = { loading: false, error: null, refresh: () => {} };
    mocks.searchState = {
      ghosts: [makeGhost("Reimu")],
      total: 1,
      loadedStart: 0,
      loading: false,
      dbError: null,
    };
    mocks.getRandomGhostSpy.mockResolvedValue(makeGhost("Marisa"));
    mocks.launchGhostSpy.mockRejectedValue(new Error("boom"));

    await invokeRandomLaunch();

    expect(mocks.launcherToasts.notifyError).toHaveBeenCalledWith("card.launchError");
    const after = mocks.ghostContentSpy.mock.calls.at(-1)?.[0];
    expect(after?.error).toBeNull();
  });

  it("起動できるゴーストが無い場合は警告トーストを出し、起動しない", async () => {
    mocks.getRandomGhostSpy.mockResolvedValue(null);

    await invokeRandomLaunch();

    expect(mocks.launcherToasts.notifyWarning).toHaveBeenCalledWith("header.randomLaunch.empty");
    expect(mocks.launchGhostSpy).not.toHaveBeenCalled();
  });
});

describe("App - スキャン中インジケータ（再スキャン時のみ）", () => {
  it("再スキャン中（loading かつ 一覧あり）は 300ms 後に scan バーを表示する", () => {
    vi.useFakeTimers();
    try {
      mocks.ghostsState = { loading: true, error: null, refresh: () => {} };
      mocks.searchState = {
        ghosts: [makeGhost("Reimu")],
        total: 1,
        loadedStart: 0,
        loading: false,
        dbError: null,
      };
      render(<App />);
      // 300ms 未満は出ない（ちらつき防止）
      expect(screen.queryByRole("progressbar")).toBeNull();
      act(() => { vi.advanceTimersByTime(300); });
      expect(screen.getByRole("progressbar")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("初回スキャン（一覧なし）では scan バーを出さない（全画面スピナーに委ねる）", () => {
    vi.useFakeTimers();
    try {
      mocks.ghostsState = { loading: true, error: null, refresh: () => {} };
      mocks.searchState = { ghosts: [], total: 0, loadedStart: 0, loading: false, dbError: null };
      render(<App />);
      act(() => { vi.advanceTimersByTime(300); });
      expect(screen.queryByRole("progressbar")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
