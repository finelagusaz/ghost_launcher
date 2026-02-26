import { useState, useEffect, useCallback, useRef } from "react";
import { settingsStore } from "../lib/settingsStore";

export function useSettings() {
  const [sspPath, setSspPath] = useState<string | null>(null);
  const [ghostFolders, setGhostFolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const ghostFoldersRef = useRef<string[]>([]);

  useEffect(() => {
    const load = async () => {
      try {
        const [path, folders] = await Promise.all([
          settingsStore.get<string>("ssp_path"),
          settingsStore.get<string[]>("ghost_folders"),
        ]);
        setSspPath(path ?? null);
        const loadedFolders = folders ?? [];
        setGhostFolders(loadedFolders);
        ghostFoldersRef.current = loadedFolders;
      } catch {
        setSspPath(null);
        setGhostFolders([]);
        ghostFoldersRef.current = [];
      } finally {
        setLoading(false);
      }
    };
    load();
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

  return { sspPath, saveSspPath, ghostFolders, addGhostFolder, removeGhostFolder, loading };
}
