import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
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
});
