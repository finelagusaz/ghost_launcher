import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useSettings } from "./useSettings";
import { settingsStore } from "../lib/settingsStore";
import { i18n, applyUserLocale } from "../lib/i18n";

vi.mock("../lib/settingsStore", () => ({
  settingsStore: {
    get: vi.fn(),
    set: vi.fn(),
    save: vi.fn(),
  },
}));

vi.mock("../lib/i18n", () => ({
  i18n: {
    language: "en",
    changeLanguage: vi.fn(),
  },
  applyUserLocale: vi.fn(),
  LANGUAGE_STORE_KEY: "language",
  isSupportedLanguage: (value: string) => ["ja", "en", "zh-CN", "zh-TW", "ko", "ru"].includes(value),
}));

describe("useSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ssp_path と ghost_folders 読み込み完了時点で loading=false になる", async () => {
    vi.mocked(settingsStore.get)
      .mockImplementation(async (key: string) => {
        if (key === "ssp_path") {
          return "C:/SSP";
        }
        if (key === "ghost_folders") {
          return ["C:/ghosts"];
        }
        if (key === "language") {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return "ja";
        }
        return null;
      });

    let resolveLanguageChange: (() => void) | null = null;
    vi.mocked(i18n.changeLanguage).mockImplementation(() => new Promise<void>((resolve) => {
      resolveLanguageChange = resolve;
    }));
    vi.mocked(applyUserLocale).mockResolvedValue(undefined);

    const { result } = renderHook(() => useSettings());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.sspPath).toBe("C:/SSP");
    expect(result.current.ghostFolders).toEqual(["C:/ghosts"]);
    expect(result.current.language).toBe("en");

    await waitFor(() => {
      expect(i18n.changeLanguage).toHaveBeenCalledWith("ja");
      expect(result.current.languageApplying).toBe(true);
      expect(result.current.loading).toBe(false);
    });

    resolveLanguageChange?.();

    await waitFor(() => {
      expect(result.current.languageApplying).toBe(false);
      expect(result.current.language).toBe("ja");
    });

    expect(applyUserLocale).toHaveBeenCalledWith("ja");
  });

  async function loaded(sspPath: string | null, folders: string[]) {
    vi.mocked(settingsStore.get).mockImplementation(async (key: string) => {
      if (key === "ssp_path") return sspPath;
      if (key === "ghost_folders") return folders;
      return null;
    });
    const hook = renderHook(() => useSettings());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    return hook;
  }

  it("表記だけが違う登録済みフォルダは追加せず duplicate を返す", async () => {
    const { result } = await loaded("C:/SSP", [String.raw`C:\Ghosts`]);
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.addGhostFolder("c:/ghosts/");
    });
    expect(outcome).toBe("duplicate");
    expect(result.current.ghostFolders).toEqual([String.raw`C:\Ghosts`]);
    expect(settingsStore.set).not.toHaveBeenCalled();
  });

  it("SSP の ghost フォルダは追加せず sspGhostFolder を返す", async () => {
    const { result } = await loaded("C:/SSP", []);
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.addGhostFolder(String.raw`C:\SSP\ghost`);
    });
    expect(outcome).toBe("sspGhostFolder");
    expect(result.current.ghostFolders).toEqual([]);
  });

  it("追加フォルダの保存に失敗したら元に戻して失敗を投げる", async () => {
    const { result } = await loaded("C:/SSP", ["C:/A"]);
    vi.mocked(settingsStore.save).mockRejectedValueOnce(new Error("disk full"));
    await act(async () => {
      await expect(result.current.addGhostFolder("C:/B")).rejects.toThrow("disk full");
    });
    expect(result.current.ghostFolders).toEqual(["C:/A"]);
  });

  it("SSP フォルダの保存に失敗したら値を変えず失敗を投げる", async () => {
    const { result } = await loaded("C:/SSP", []);
    vi.mocked(settingsStore.save).mockRejectedValueOnce(new Error("disk full"));
    await act(async () => {
      await expect(result.current.saveSspPath("C:/SSP2")).rejects.toThrow("disk full");
    });
    expect(result.current.sspPath).toBe("C:/SSP");
  });
});
