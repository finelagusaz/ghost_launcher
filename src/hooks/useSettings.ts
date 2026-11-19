import { useState, useEffect, useCallback, useRef } from "react";
import { settingsStore } from "../lib/settingsStore";
import { i18n, applyUserLocale, LANGUAGE_STORE_KEY, isSupportedLanguage, type Language } from "../lib/i18n";
import { rejectReasonForNewFolder, type FolderRejectReason } from "../lib/ghostScanUtils";

/// 追加フォルダの追加の結果。拒否したときは理由を返す（保存の失敗は例外で伝える）。
export type AddFolderOutcome = "added" | FolderRejectReason;

export function useSettings() {
  const [sspPath, setSspPath] = useState<string | null>(null);
  const [ghostFolders, setGhostFolders] = useState<string[]>([]);
  const [language, setLanguageState] = useState<Language>(() => i18n.language as Language);
  const [loading, setLoading] = useState(true);
  const [languageApplying, setLanguageApplying] = useState(false);
  const ghostFoldersRef = useRef<string[]>([]);
  const sspPathRef = useRef<string | null>(null);
  sspPathRef.current = sspPath;

  useEffect(() => {
    let active = true;

    const applySavedLanguage = async () => {
      try {
        const lang = await settingsStore.get<Language>(LANGUAGE_STORE_KEY);
        if (!active || !lang || !isSupportedLanguage(lang)) {
          return;
        }

        setLanguageApplying(true);
        await i18n.changeLanguage(lang);
        await applyUserLocale(lang);

        if (!active) {
          return;
        }

        setLanguageState(lang);
      } catch {
        // 言語設定の復元に失敗しても、アプリの初期描画は継続する
      } finally {
        if (active) {
          setLanguageApplying(false);
        }
      }
    };

    const load = async () => {
      try {
        const [path, folders] = await Promise.all([
          settingsStore.get<string>("ssp_path"),
          settingsStore.get<string[]>("ghost_folders"),
        ]);

        if (!active) {
          return;
        }

        setSspPath(path ?? null);
        const loadedFolders = folders ?? [];
        setGhostFolders(loadedFolders);
        ghostFoldersRef.current = loadedFolders;
      } catch {
        if (!active) {
          return;
        }

        setSspPath(null);
        setGhostFolders([]);
        ghostFoldersRef.current = [];
      } finally {
        if (active) {
          setLoading(false);
        }
      }

      void applySavedLanguage();
    };

    void load();

    return () => {
      active = false;
    };
  }, []);

  /// 保存に失敗したら値を変えずに失敗を投げる（呼び出し側が画面に知らせる）。
  const saveSspPath = useCallback(async (path: string) => {
    await settingsStore.set("ssp_path", path);
    await settingsStore.save();
    setSspPath(path);
  }, []);

  const saveLanguage = useCallback(async (lang: Language) => {
    await i18n.changeLanguage(lang);
    await applyUserLocale(lang);
    setLanguageState(lang);
    try {
      await settingsStore.set(LANGUAGE_STORE_KEY, lang);
      await settingsStore.save();
    } catch (error) {
      console.error("言語設定の保存に失敗しました", error);
    }
  }, []);

  const persistGhostFolders = useCallback(async (folders: string[]) => {
    await settingsStore.set("ghost_folders", folders);
    await settingsStore.save();
  }, []);

  /// 追加フォルダを先に画面へ反映してから保存する。保存に失敗したら元に戻して失敗を投げる
  /// （呼び出し側が画面に知らせる）。
  const updateGhostFolders = useCallback(async (updated: string[]) => {
    const previous = ghostFoldersRef.current;
    setGhostFolders(updated);
    ghostFoldersRef.current = updated;

    try {
      await persistGhostFolders(updated);
    } catch (error) {
      setGhostFolders(previous);
      ghostFoldersRef.current = previous;
      throw error;
    }
  }, [persistGhostFolders]);

  const addGhostFolder = useCallback(async (folder: string): Promise<AddFolderOutcome> => {
    const previous = ghostFoldersRef.current;
    const reason = rejectReasonForNewFolder(folder, previous, sspPathRef.current);
    if (reason) {
      return reason;
    }
    await updateGhostFolders([...previous, folder]);
    return "added";
  }, [updateGhostFolders]);

  const removeGhostFolder = useCallback(async (folder: string) => {
    const previous = ghostFoldersRef.current;
    const updated = previous.filter((value) => value !== folder);
    if (updated.length === previous.length) {
      return;
    }
    await updateGhostFolders(updated);
  }, [updateGhostFolders]);

  return {
    sspPath,
    saveSspPath,
    ghostFolders,
    addGhostFolder,
    removeGhostFolder,
    language,
    saveLanguage,
    loading,
    languageApplying,
  };
}
