import { useCallback, useDeferredValue, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Spinner,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { useSettings } from "./hooks/useSettings";
import { useGhosts } from "./hooks/useGhosts";
import { useSearch } from "./hooks/useSearch";
import { useAppShellState } from "./hooks/useAppShellState";
import { AppHeader } from "./components/AppHeader";
import { GhostContent } from "./components/GhostContent";
import { SettingsPanel } from "./components/SettingsPanel";
import { buildAdditionalFolders, buildRequestKey } from "./lib/ghostScanUtils";
import { getRandomGhost, recordLaunch } from "./lib/ghostDatabase";
import { invoke } from "@tauri-apps/api/core";
import type { SortOrder } from "./types";

const useStyles = makeStyles({
  app: {
    maxWidth: "960px",
    margin: "0 auto",
    minHeight: "100vh",
    padding: "24px 20px 32px",
    "@media (max-width: 600px)": {
      padding: "16px 12px 24px",
    },
  },
  shell: {
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    padding: "24px",
    minWidth: 0,
    overflowX: "hidden",
    "@media (max-width: 600px)": {
      padding: "16px",
    },
  },
  loading: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  dialogSurface: {
    width: "min(760px, calc(100% - 24px))",
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow16,
  },
});

function App() {
  const styles = useStyles();
  const { t } = useTranslation();
  const {
    sspPath,
    saveSspPath,
    ghostFolders,
    addGhostFolder,
    removeGhostFolder,
    language,
    saveLanguage,
    loading: settingsLoading,
    languageApplying,
  } = useSettings();
  const { loading: ghostsLoading, error, refresh } = useGhosts(sspPath, ghostFolders);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("name");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const LIMIT = 500;

  const {
    settingsOpen,
    setSettingsOpen,
    openSettings,
    closeSettings,
    offset,
    setOffset,
    refreshTrigger,
  } = useAppShellState({
    settingsLoading,
    sspPath,
    deferredSearchQuery,
    ghostsLoading,
  });

  const searchRequestKey = (refreshTrigger > 0 && sspPath)
    ? buildRequestKey(sspPath, buildAdditionalFolders(ghostFolders))
    : null;

  const { ghosts: searchResultGhosts, total: searchTotal, loadedStart, loading: searchLoading, dbError } = useSearch(
    searchRequestKey,
    deferredSearchQuery,
    LIMIT,
    offset,
    refreshTrigger,
    sortOrder,
  );

  const handleLoadMore = useCallback((targetOffset: number) => {
    if (!searchLoading) {
      setOffset(targetOffset);
    }
  }, [searchLoading, setOffset]);

  const handleRefresh = useCallback(() => refresh({ forceFullScan: true }), [refresh]);
  const handleOpenSettings = openSettings;
  const handleCloseSettings = closeSettings;

  const [randomLaunchError, setRandomLaunchError] = useState<string | null>(null);
  const handleRandomLaunch = useCallback(async () => {
    if (!searchRequestKey || !sspPath) return;
    setRandomLaunchError(null);
    try {
      const ghost = await getRandomGhost(searchRequestKey);
      if (!ghost) {
        setRandomLaunchError(t("header.randomLaunch.empty"));
        return;
      }
      await invoke("launch_ghost", {
        sspPath,
        ghostDirectoryName: ghost.directory_name,
        ghostSource: ghost.source,
      });
      if (ghost.ghost_identity_key) {
        void recordLaunch(ghost.ghost_identity_key).catch(() => {});
      }
    } catch (e) {
      setRandomLaunchError(e instanceof Error ? e.message : String(e));
    }
  }, [searchRequestKey, sspPath, t]);

  const handleSortChange = useCallback((value: SortOrder) => {
    setSortOrder(value);
    setOffset(0);
  }, [setOffset]);

  if (settingsLoading) {
    return (
      <div className={styles.loading}>
        <Spinner label={t("app.loading")} />
      </div>
    );
  }

  return (
    <div className={styles.app}>
      <div className={styles.shell}>
        <AppHeader
          sspPath={sspPath}
          ghostsLoading={ghostsLoading}
          onRefresh={handleRefresh}
          onOpenSettings={handleOpenSettings}
          onRandomLaunch={handleRandomLaunch}
        />
        <GhostContent
          ghosts={searchResultGhosts}
          total={searchTotal}
          loadedStart={loadedStart}
          sspPath={sspPath}
          searchQuery={searchQuery}
          sortOrder={sortOrder}
          loading={ghostsLoading}
          searchLoading={searchLoading}
          error={error ?? dbError ?? randomLaunchError}
          onSearchChange={setSearchQuery}
          onSortChange={handleSortChange}
          onOpenSettings={handleOpenSettings}
          onLoadMore={handleLoadMore}
        />
      </div>

      <Dialog
        modalType="modal"
        open={settingsOpen}
        onOpenChange={(_: unknown, data: { open: boolean }) => setSettingsOpen(data.open)}
      >
        <DialogSurface className={styles.dialogSurface}>
          <DialogBody>
            <DialogTitle>{t("app.settings.title")}</DialogTitle>
            <DialogContent>
              <SettingsPanel
                sspPath={sspPath}
                onPathChange={saveSspPath}
                ghostFolders={ghostFolders}
                onAddFolder={addGhostFolder}
                onRemoveFolder={removeGhostFolder}
                language={language}
                onLanguageChange={saveLanguage}
                languageApplying={languageApplying}
              />
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={handleCloseSettings} data-testid="settings-close-button">
                {t("app.settings.close")}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

export default App;
