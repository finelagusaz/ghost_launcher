import { useState, useEffect, useCallback } from "react";
import { settingsStore } from "../lib/settingsStore";

export function useSettings() {
  const [sspPath, setSspPath] = useState<string | null>(null);
  const [ghostFolders, setGhostFolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const path = await settingsStore.get<string>("ssp_path");
        setSspPath(path ?? null);
        const folders = await settingsStore.get<string[]>("ghost_folders");
        setGhostFolders(folders ?? []);
      } catch {
        setSspPath(null);
        setGhostFolders([]);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const saveSspPath = useCallback(async (path: string) => {
    await settingsStore.set("ssp_path", path);
    await settingsStore.save();
    setSspPath(path);
  }, []);

  const addGhostFolder = useCallback(async (folder: string) => {
    setGhostFolders((prev) => {
      if (prev.includes(folder)) return prev;
      const updated = [...prev, folder];
      settingsStore.set("ghost_folders", updated).then(() => settingsStore.save());
      return updated;
    });
  }, []);

  const removeGhostFolder = useCallback(async (folder: string) => {
    setGhostFolders((prev) => {
      const updated = prev.filter((f) => f !== folder);
      settingsStore.set("ghost_folders", updated).then(() => settingsStore.save());
      return updated;
    });
  }, []);

  return { sspPath, saveSspPath, ghostFolders, addGhostFolder, removeGhostFolder, loading };
}
