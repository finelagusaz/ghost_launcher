import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScanProgressBar } from "./ScanProgressBar";

// t はキーをそのまま返すスタブ（App.test と同方針）
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("ScanProgressBar", () => {
  it("visible=true で progressbar を aria-label 付きで描画する", () => {
    render(<ScanProgressBar visible={true} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveAttribute("aria-label", "list.scanning");
  });

  it("visible=false ではトラックのみで progressbar を描画しない（レイアウトシフト回避）", () => {
    render(<ScanProgressBar visible={false} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByTestId("scan-progress-track")).toBeInTheDocument();
  });
});
