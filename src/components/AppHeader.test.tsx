import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppHeader } from "./AppHeader";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("AppHeader", () => {
  it("タイトルとアクションボタンが表示される", () => {
    render(
      <AppHeader
        sspPath="C:/SSP"
        ghostsLoading={false}
        onRefresh={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId("settings-button")).toBeInTheDocument();
  });

  it("SSP パス未設定のとき更新ボタンは表示されない", () => {
    render(
      <AppHeader
        sspPath={null}
        ghostsLoading={false}
        onRefresh={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(screen.queryByText("header.refresh")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-button")).toBeInTheDocument();
  });
});
