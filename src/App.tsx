import { useCallback, useDeferredValue, useEffect, useState, useRef } from "react";
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
import { AppHeader } from "./components/AppHeader";
import { GhostContent } from "./components/GhostContent";
import { SettingsPanel } from "./components/SettingsPanel";

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
  const {
    sspPath,
    saveSspPath,
    ghostFolders,
    addGhostFolder,
    removeGhostFolder,
    loading: settingsLoading,
  } = useSettings();
  const { loading: ghostsLoading, error, refresh } = useGhosts(sspPath, ghostFolders);
  const [searchQuery, setSearchQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const [offset, setOffset] = useState(0);
  const LIMIT = 100;
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const prevLoadingRef = useRef(true);

  useEffect(() => {
    if (prevLoadingRef.current && !ghostsLoading) {
      // scan completed
      setRefreshTrigger((v) => v + 1);
      setOffset(0);
    }
    prevLoadingRef.current = ghostsLoading;
  }, [ghostsLoading]);

  useEffect(() => {
    setOffset(0);
  }, [deferredSearchQuery]);

  const { ghosts: searchResultGhosts, total: searchTotal, loading: searchLoading, dbError } = useSearch(
    deferredSearchQuery,
    LIMIT,
    offset,
    refreshTrigger
  );

  const handleLoadMore = useCallback(() => {
    if (!searchLoading && searchResultGhosts.length < searchTotal) {
      setOffset((prev) => prev + LIMIT);
    }
  }, [searchLoading, searchResultGhosts.length, searchTotal]);

  const handleRefresh = useCallback(() => refresh({ forceFullScan: true }), [refresh]);
  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const handleCloseSettings = useCallback(() => setSettingsOpen(false), []);

  useEffect(() => {
    if (!settingsLoading && !sspPath) {
      setSettingsOpen(true);
    }
  }, [settingsLoading, sspPath]);

  if (settingsLoading) {
    return (
      <div className={styles.loading}>
        <Spinner label="読み込み中..." />
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
        />
        <GhostContent
          ghosts={searchResultGhosts}
          total={searchTotal}
          sspPath={sspPath}
          searchQuery={searchQuery}
          loading={ghostsLoading}
          searchLoading={searchLoading}
          error={error ?? dbError}
          onSearchChange={setSearchQuery}
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
            <DialogTitle>設定</DialogTitle>
            <DialogContent>
              <SettingsPanel
                sspPath={sspPath}
                onPathChange={saveSspPath}
                ghostFolders={ghostFolders}
                onAddFolder={addGhostFolder}
                onRemoveFolder={removeGhostFolder}
              />
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={handleCloseSettings}>
                閉じる
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

export default App;
