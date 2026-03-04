import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsPanel } from "./SettingsPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../lib/i18n", () => ({
  SUPPORTED_LANGUAGES: ["ja", "en"],
  isSupportedLanguage: (v: string) => ["ja", "en"].includes(v),
}));

describe("SettingsPanel", () => {
  const defaultProps = {
    sspPath: null,
    onPathChange: vi.fn(),
    ghostFolders: [],
    onAddFolder: vi.fn(),
    onRemoveFolder: vi.fn(),
    language: "ja" as const,
    onLanguageChange: vi.fn(),
  };

  it("SSP パス未設定でもクラッシュせずレンダリングされる", () => {
    render(<SettingsPanel {...defaultProps} />);
    expect(screen.getByText("settings.ssp.select")).toBeInTheDocument();
  });

  it("SSP パス設定済みで Input に反映される", () => {
    render(<SettingsPanel {...defaultProps} sspPath="C:/SSP" />);
    const input = screen.getByDisplayValue("C:/SSP");
    expect(input).toBeInTheDocument();
  });

  it("ゴーストフォルダが一覧表示され削除ボタンが存在する", () => {
    render(<SettingsPanel {...defaultProps} ghostFolders={["C:/ghosts/A", "C:/ghosts/B"]} />);
    expect(screen.getByDisplayValue("C:/ghosts/A")).toBeInTheDocument();
    expect(screen.getByDisplayValue("C:/ghosts/B")).toBeInTheDocument();
    const deleteButtons = screen.getAllByText("settings.folders.delete");
    expect(deleteButtons).toHaveLength(2);
  });
});
