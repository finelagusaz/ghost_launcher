import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { GhostContent } from "./GhostContent";
import type { GhostView } from "../types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Enter 起動の共有ランチャはスパイに差し替える
const mocks = vi.hoisted(() => ({
  launchSpy: vi.fn(),
}));
vi.mock("../hooks/useGhostLauncher", () => ({
  useGhostLauncher: () => mocks.launchSpy,
}));
// GhostCard が使うトースト/起動は無害化する（本テストはカード起動を叩かない）
vi.mock("../hooks/useLauncherToasts", () => ({
  useLauncherToasts: () => ({ notifySuccess: vi.fn(), notifyError: vi.fn(), notifyWarning: vi.fn() }),
  TOASTER_ID: "test-toaster",
}));
vi.mock("../lib/sspClient", () => ({
  launchGhost: vi.fn(),
}));

function makeGhost(name: string): GhostView {
  return {
    name,
    directory_name: name.toLowerCase(),
    path: `/${name}`,
    source: "ssp",
    name_lower: name.toLowerCase(),
    directory_name_lower: name.toLowerCase(),
  } as GhostView;
}

const baseProps = {
  sspPath: "C:/SSP",
  searchQuery: "",
  sortOrder: "name" as const,
  loading: false,
  searchLoading: false,
  error: null as string | null,
  onSearchChange: vi.fn(),
  onSortChange: vi.fn(),
  onRandomLaunch: vi.fn(),
  onOpenSettings: vi.fn(),
  onLoadMore: vi.fn(),
};

// 選択中（data-selected）のカードのゴースト名を返す
function selectedName(): string | null {
  const card = document.querySelector('[data-selected="true"]');
  return card ? within(card as HTMLElement).getByTestId("ghost-name").textContent : null;
}

describe("GhostContent - キーボード選択と Enter 起動", () => {
  beforeEach(() => {
    // GhostCard の TruncatedText が ResizeObserver を使う
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(function () {
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    mocks.launchSpy.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("既定で先頭候補がハイライトされ、↑/↓ で選択が移動する", () => {
    const ghosts = [makeGhost("Reimu"), makeGhost("Marisa"), makeGhost("Sanae")];
    render(<GhostContent {...baseProps} ghosts={ghosts} total={3} loadedStart={0} />);

    const input = screen.getByRole("textbox");
    expect(selectedName()).toBe("Reimu");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selectedName()).toBe("Marisa");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(selectedName()).toBe("Reimu");
  });

  it("Enter で選択中のゴーストを起動する", () => {
    const ghosts = [makeGhost("Reimu"), makeGhost("Marisa"), makeGhost("Sanae")];
    render(<GhostContent {...baseProps} ghosts={ghosts} total={3} loadedStart={0} />);

    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "ArrowDown" }); // Marisa を選択
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mocks.launchSpy).toHaveBeenCalledTimes(1);
    expect(mocks.launchSpy.mock.calls[0][0]).toMatchObject({ name: "Marisa" });
  });

  it("検索クエリ変更で選択が先頭へ戻る", () => {
    const ghosts = [makeGhost("Reimu"), makeGhost("Marisa"), makeGhost("Sanae")];
    const { rerender } = render(
      <GhostContent {...baseProps} ghosts={ghosts} total={3} loadedStart={0} />,
    );

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowDown" });
    expect(selectedName()).toBe("Marisa");

    rerender(<GhostContent {...baseProps} ghosts={ghosts} total={3} loadedStart={0} searchQuery="x" />);
    expect(selectedName()).toBe("Reimu");
  });

  it("選択行が読込済み範囲外なら Enter で起動しない（未ロード行のガード）", () => {
    // 仮想化: 全 100 件・読込済みは index 5〜6 のみ。初期選択 index 0 は範囲外
    const ghosts = [makeGhost("G5"), makeGhost("G6")];
    render(<GhostContent {...baseProps} ghosts={ghosts} total={100} loadedStart={5} />);

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(mocks.launchSpy).not.toHaveBeenCalled();
  });
});
