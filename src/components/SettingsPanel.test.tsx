import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { open } from "@tauri-apps/plugin-dialog";
import { SettingsPanel } from "./SettingsPanel";

// t は既定（ja）ではキーをそのまま返す。lang を変えると「{lang}:{key}」を返し、
// 再描画で言語切替に追従したかを見分けられる
const i18nState = vi.hoisted(() => ({ lang: "ja" }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => (i18nState.lang === "ja" ? key : `${i18nState.lang}:${key}`),
  }),
}));

const mocks = vi.hoisted(() => ({ validateSspPath: vi.fn() }));
vi.mock("../lib/sspClient", () => ({
  validateSspPath: (...args: unknown[]) => mocks.validateSspPath(...args),
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

  it("SSP フォルダの検証エラーは言語の切替に追従する", async () => {
    vi.mocked(open).mockResolvedValue("C:/NoSsp");
    mocks.validateSspPath.mockRejectedValue({ kind: "sspExeNotFound", path: "C:/NoSsp/ssp.exe" });
    const { rerender } = render(<SettingsPanel {...defaultProps} />);

    fireEvent.click(screen.getByText("settings.ssp.select"));
    expect(await screen.findByText("error.sspExeNotFound")).toBeInTheDocument();

    try {
      i18nState.lang = "en";
      rerender(<SettingsPanel {...defaultProps} language="en" />);
      expect(screen.getByText("en:error.sspExeNotFound")).toBeInTheDocument();
    } finally {
      i18nState.lang = "ja";
    }
  });
});
