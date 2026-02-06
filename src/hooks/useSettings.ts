import { useState, useEffect, useCallback } from "react";
import { LazyStore } from "@tauri-apps/plugin-store";

const store = new LazyStore("settings.json");

export function useSettings() {
  const [sspPath, setSspPath] = useState<string | null>(null);
  const [ghostFolders, setGhostFolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const path = await store.get<string>("ssp_path");
        setSspPath(path ?? null);
        const folders = await store.get<string[]>("ghost_folders");
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
    await store.set("ssp_path", path);
    await store.save();
    setSspPath(path);
  }, []);

  const addGhostFolder = useCallback(async (folder: string) => {
    setGhostFolders((prev) => {
      if (prev.includes(folder)) return prev;
      const updated = [...prev, folder];
      store.set("ghost_folders", updated).then(() => store.save());
      return updated;
    });
  }, []);

  const removeGhostFolder = useCallback(async (folder: string) => {
    setGhostFolders((prev) => {
      const updated = prev.filter((f) => f !== folder);
      store.set("ghost_folders", updated).then(() => store.save());
      return updated;
    });
  }, []);

  return { sspPath, saveSspPath, ghostFolders, addGhostFolder, removeGhostFolder, loading };
}
