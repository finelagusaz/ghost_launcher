import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FluentProvider, Toaster, webLightTheme } from "@fluentui/react-components";
import { TOASTER_ID, useLauncherToasts } from "./useLauncherToasts";

// フックを実際に呼び、ボタン押下で notify を発火するハーネス
function Harness() {
  const { notifySuccess } = useLauncherToasts();
  return <button onClick={() => notifySuccess("トースト表示テスト")}>fire</button>;
}

describe("useLauncherToasts", () => {
  beforeEach(() => {
    // Toaster/Toast は ResizeObserver を使うため jsdom 用にスタブする
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(function () {
        return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // モックを挟まず TOASTER_ID の共有配線・<Toast> 描画・portal マウントまで通す
  it("Toaster と ID を共有し notify で実際にトーストが描画される", async () => {
    render(
      <FluentProvider theme={webLightTheme}>
        <Toaster toasterId={TOASTER_ID} />
        <Harness />
      </FluentProvider>,
    );

    fireEvent.click(screen.getByText("fire"));

    expect(await screen.findByText("トースト表示テスト")).toBeInTheDocument();
  });
});
