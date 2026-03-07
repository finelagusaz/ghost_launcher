import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { GhostCard } from "./GhostCard";
import type { Ghost } from "../types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const makeGhost = (overrides?: Partial<Ghost>): Ghost => ({
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
