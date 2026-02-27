import { useCallback, useEffect, useRef, useState } from "react";

interface UseAppShellStateParams {
  settingsLoading: boolean;
  sspPath: string | null;
  deferredSearchQuery: string;
  ghostsLoading: boolean;
}

export function useAppShellState({
  settingsLoading,
  sspPath,
  deferredSearchQuery,
  ghostsLoading,
}: UseAppShellStateParams) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const prevLoadingRef = useRef(true);

  useEffect(() => {
    if (!settingsLoading && !sspPath) {
      setSettingsOpen(true);
    }
  }, [settingsLoading, sspPath]);

  useEffect(() => {
    setOffset(0);
  }, [deferredSearchQuery]);

  useEffect(() => {
    if (prevLoadingRef.current && !ghostsLoading) {
      setRefreshTrigger((prev) => prev + 1);
      setOffset(0);
    }
    prevLoadingRef.current = ghostsLoading;
  }, [ghostsLoading]);

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  return {
    settingsOpen,
    setSettingsOpen,
    openSettings,
    closeSettings,
    offset,
    setOffset,
    refreshTrigger,
  };
}
