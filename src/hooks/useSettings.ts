import { useState, useEffect, useCallback, useRef } from "react";
import { settingsStore } from "../lib/settingsStore";
import { GHOST_CACHE_KEY, isGhostCacheStoreV1 } from "../lib/ghostCacheRepository";
import type { GhostCacheStoreV1 } from "../types";

export function useSettings() {
  const [sspPath, setSspPath] = useState<string | null>(null);
  const [ghostFolders, setGhostFolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [initialGhostCache, setInitialGhostCache] = useState<GhostCacheStoreV1 | null>(null);
  const ghostFoldersRef = useRef<string[]>([]);

  useEffect(() => {
    const load = async () => {
      try {
        const [path, folders, rawCache] = await Promise.all([
          settingsStore.get<string>("ssp_path"),
          settingsStore.get<string[]>("ghost_folders"),
          settingsStore.get<unknown>(GHOST_CACHE_KEY),
        ]);
        setSspPath(path ?? null);
        const loadedFolders = folders ?? [];
        setGhostFolders(loadedFolders);
        ghostFoldersRef.current = loadedFolders;
        if (isGhostCacheStoreV1(rawCache)) {
          setInitialGhostCache(rawCache);
        }
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

  const addGhostFolder = useCallback(async (folder: string) => {
    const previous = ghostFoldersRef.current;
    if (previous.includes(folder)) {
      return;
    }

    const updated = [...previous, folder];
    setGhostFolders(updated);
    ghostFoldersRef.current = updated;

    try {
      await persistGhostFolders(updated);
    } catch (error) {
      console.error("追加フォルダ設定の保存に失敗しました", error);
      setGhostFolders(previous);
      ghostFoldersRef.current = previous;
    }
  }, [persistGhostFolders]);

  const removeGhostFolder = useCallback(async (folder: string) => {
    const previous = ghostFoldersRef.current;
    const updated = previous.filter((value) => value !== folder);
    if (updated.length === previous.length) {
      return;
    }

    setGhostFolders(updated);
    ghostFoldersRef.current = updated;

    try {
      await persistGhostFolders(updated);
    } catch (error) {
      console.error("追加フォルダ設定の削除保存に失敗しました", error);
      setGhostFolders(previous);
      ghostFoldersRef.current = previous;
    }
  }, [persistGhostFolders]);

  return { sspPath, saveSspPath, ghostFolders, addGhostFolder, removeGhostFolder, loading, initialGhostCache };
}
