import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import { GhostCard } from "./GhostCard";
import type { GhostView } from "../types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// 起動の成否とトースト通知をテストごとに制御する
const mocks = vi.hoisted(() => ({
  launchGhostSpy: vi.fn(),
  launcherToasts: {
    notifySuccess: vi.fn(),
    notifyError: vi.fn(),
    notifyWarning: vi.fn(),
  },
}));
vi.mock("../lib/sspClient", () => ({
  launchGhost: (...args: unknown[]) => mocks.launchGhostSpy(...args),
}));
vi.mock("../hooks/useLauncherToasts", () => ({
  useLauncherToasts: () => mocks.launcherToasts,
  TOASTER_ID: "test-toaster",
}));

const makeGhost = (overrides?: Partial<GhostView>): GhostView => ({
  name: "テストゴースト",
  sakura_name: "",
  kero_name: "",
  craftman: "",
  craftmanw: "",
  directory_name: "test_ghost",
  path: "/test/path",
  source: "ssp",
  thumbnail_path: "",
  thumbnail_use_self_alpha: false,
  thumbnail_kind: "",
  name_lower: "",
  sakura_name_lower: "",
  kero_name_lower: "",
  craftman_lower: "",
  craftmanw_lower: "",
  directory_name_lower: "",
  ...overrides,
});

describe("GhostCard の TruncatedText: ウィンドウリサイズ対応", () => {
  let resizeCallbacks: ResizeObserverCallback[];

  beforeEach(() => {
    resizeCallbacks = [];
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(function (cb: ResizeObserverCallback) {
        resizeCallbacks.push(cb);
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("初期状態でテキストが収まっているときはツールチップを表示しない", () => {
    render(<GhostCard ghost={makeGhost()} sspPath="C:/SSP" />);
    const nameEl = screen.getByTestId("ghost-name");
    // jsdom は scrollWidth = clientWidth = 0 → 切り詰めなし
    expect(nameEl).not.toHaveAttribute("aria-label");
  });

  it("リサイズ後にテキストが切れたらツールチップが表示される", () => {
    render(<GhostCard ghost={makeGhost({ name: "非常に長いゴースト名前" })} sspPath="C:/SSP" />);

    // 初期状態はツールチップなし
    expect(screen.getByTestId("ghost-name")).not.toHaveAttribute("aria-label");

    // 切り詰めをシミュレート（scrollWidth > clientWidth）
    const nameElBefore = screen.getByTestId("ghost-name");
    Object.defineProperty(nameElBefore, "scrollWidth", { get: () => 300, configurable: true });
    Object.defineProperty(nameElBefore, "clientWidth", { get: () => 100, configurable: true });

    // ResizeObserver のコールバックをトリガー
    act(() => {
      resizeCallbacks.forEach((cb) => cb([], {} as ResizeObserver));
    });

    // 再レンダリング後の要素を再取得して確認
    // Tooltip(relationship="label") が aria-label を付与する
    expect(screen.getByTestId("ghost-name")).toHaveAttribute("aria-label");
  });

  it("リサイズ後にテキストが収まるようになったらツールチップが消える", () => {
    render(<GhostCard ghost={makeGhost({ name: "短い名前" })} sspPath="C:/SSP" />);

    // check() クロージャが参照する el = 初回マウント時の要素
    const initialEl = screen.getByTestId("ghost-name");

    // まず切り詰め状態にする
    Object.defineProperty(initialEl, "scrollWidth", { get: () => 300, configurable: true });
    Object.defineProperty(initialEl, "clientWidth", { get: () => 100, configurable: true });
    act(() => {
      resizeCallbacks.forEach((cb) => cb([], {} as ResizeObserver));
    });
    expect(screen.getByTestId("ghost-name")).toHaveAttribute("aria-label");

    // 次に収まる状態にする（幅が広がった）
    // el クロージャは initialEl を参照したまま → 同じオブジェクトに設定する
    Object.defineProperty(initialEl, "scrollWidth", { get: () => 50, configurable: true });
    Object.defineProperty(initialEl, "clientWidth", { get: () => 200, configurable: true });
    act(() => {
      resizeCallbacks.forEach((cb) => cb([], {} as ResizeObserver));
    });

    expect(screen.getByTestId("ghost-name")).not.toHaveAttribute("aria-label");
  });
});

describe("GhostCard の起動フィードバック", () => {
  beforeEach(() => {
    // GhostCard は TruncatedText 経由で ResizeObserver を使う
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(function () {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    mocks.launchGhostSpy.mockReset();
    mocks.launcherToasts.notifySuccess.mockReset();
    mocks.launcherToasts.notifyError.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("起動成功時に成功トーストを出す", async () => {
    mocks.launchGhostSpy.mockResolvedValue(undefined);
    render(<GhostCard ghost={makeGhost({ name: "Reimu" })} sspPath="C:/SSP" />);

    fireEvent.click(screen.getByTestId("launch-button"));

    await waitFor(() =>
      expect(mocks.launcherToasts.notifySuccess).toHaveBeenCalledWith("card.launchSuccess"),
    );
    expect(mocks.launchGhostSpy).toHaveBeenCalled();
  });

  it("起動失敗時は成功トーストを出さず、カード内にエラーを表示する（非破壊）", async () => {
    mocks.launchGhostSpy.mockRejectedValue(new Error("boom"));
    render(<GhostCard ghost={makeGhost({ name: "Marisa" })} sspPath="C:/SSP" />);

    fireEvent.click(screen.getByTestId("launch-button"));

    // 失敗時はカード内 role="alert" にインライン表示（既存挙動を維持）
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(mocks.launcherToasts.notifySuccess).not.toHaveBeenCalled();
  });
});
