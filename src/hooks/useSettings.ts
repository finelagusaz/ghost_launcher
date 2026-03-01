import { useState, useEffect, useCallback, useRef } from "react";
import { settingsStore } from "../lib/settingsStore";
import { i18n, applyUserLocale, LANGUAGE_STORE_KEY, isSupportedLanguage, type Language } from "../lib/i18n";

export function useSettings() {
  const [sspPath, setSspPath] = useState<string | null>(null);
  const [ghostFolders, setGhostFolders] = useState<string[]>([]);
  const [language, setLanguageState] = useState<Language>(() => i18n.language as Language);
  const [loading, setLoading] = useState(true);
  const [languageApplying, setLanguageApplying] = useState(false);
  const ghostFoldersRef = useRef<string[]>([]);

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

  const saveSspPath = useCallback(async (path: string) => {
    try {
      await settingsStore.set("ssp_path", path);
      await settingsStore.save();
      setSspPath(path);
    } catch (error) {
      console.error("SSPフォルダ設定の保存に失敗しました", error);
    }
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

  const updateGhostFolders = useCallback(async (
    computeUpdated: (previous: string[]) => string[] | null,
    errorMessage: string,
  ) => {
    const previous = ghostFoldersRef.current;
    const updated = computeUpdated(previous);
    if (updated === null) {
      return;
    }

    setGhostFolders(updated);
    ghostFoldersRef.current = updated;

    try {
      await persistGhostFolders(updated);
    } catch (error) {
      console.error(errorMessage, error);
      setGhostFolders(previous);
      ghostFoldersRef.current = previous;
    }
  }, [persistGhostFolders]);

  const addGhostFolder = useCallback(async (folder: string) => {
    await updateGhostFolders(
      (previous) => previous.includes(folder) ? null : [...previous, folder],
      "追加フォルダ設定の保存に失敗しました",
    );
  }, [updateGhostFolders]);

  const removeGhostFolder = useCallback(async (folder: string) => {
    await updateGhostFolders(
      (previous) => {
        const updated = previous.filter((value) => value !== folder);
        return updated.length === previous.length ? null : updated;
      },
      "追加フォルダ設定の削除保存に失敗しました",
    );
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
