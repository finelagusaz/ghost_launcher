import { useState, useEffect, useCallback } from "react";
import { LazyStore } from "@tauri-apps/plugin-store";

const store = new LazyStore("settings.json");

export function useSettings() {
  const [sspPath, setSspPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const path = await store.get<string>("ssp_path");
        setSspPath(path ?? null);
      } catch {
        setSspPath(null);
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

  return { sspPath, saveSspPath, loading };
}
