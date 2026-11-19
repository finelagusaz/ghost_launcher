import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { open, confirm } from "@tauri-apps/plugin-dialog";
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

  it("フォルダ選択ダイアログを開けなかったら、その場に知らせる", async () => {
    vi.mocked(open).mockRejectedValueOnce(new Error("dialog broken"));
    render(<SettingsPanel {...defaultProps} />);

    fireEvent.click(screen.getByText("settings.ssp.select"));
    expect(await screen.findByText("settings.dialogFailed")).toBeInTheDocument();
  });

  it("SSP フォルダの検証が通ったあと保存に失敗したら、その場に知らせる", async () => {
    vi.mocked(open).mockResolvedValue("C:/SSP");
    mocks.validateSspPath.mockResolvedValue(undefined);
    const onPathChange = vi.fn().mockRejectedValue(new Error("disk full"));
    render(<SettingsPanel {...defaultProps} onPathChange={onPathChange} />);

    fireEvent.click(screen.getByText("settings.ssp.select"));
    expect(await screen.findByText("settings.saveFailed")).toBeInTheDocument();
  });

  it.each([
    ["duplicate", "settings.folders.duplicate"],
    ["sspGhostFolder", "settings.folders.sspGhostFolder"],
  ])("追加フォルダが %s で拒否されたら、理由を知らせる", async (outcome, message) => {
    vi.mocked(open).mockResolvedValue("C:/Ghosts");
    const onAddFolder = vi.fn().mockResolvedValue(outcome);
    render(<SettingsPanel {...defaultProps} onAddFolder={onAddFolder} />);

    fireEvent.click(screen.getByText("settings.folders.add"));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("追加フォルダの削除の保存に失敗したら、その場に知らせる", async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    const onRemoveFolder = vi.fn().mockRejectedValue(new Error("disk full"));
    render(<SettingsPanel {...defaultProps} ghostFolders={["C:/A"]} onRemoveFolder={onRemoveFolder} />);

    fireEvent.click(screen.getByText("settings.folders.delete"));
    expect(await screen.findByRole("alert")).toHaveTextContent("settings.saveFailed");
  });
});
