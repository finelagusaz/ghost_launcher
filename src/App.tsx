import { useDeferredValue, useEffect, useState } from "react";
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
  const { ghosts, loading: ghostsLoading, error, refresh } = useGhosts(sspPath, ghostFolders);
  const [searchQuery, setSearchQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const filteredGhosts = useSearch(ghosts, deferredSearchQuery);

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
          onRefresh={() => refresh({ forceFullScan: true })}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <GhostContent
          ghosts={filteredGhosts}
          sspPath={sspPath}
          searchQuery={searchQuery}
          loading={ghostsLoading}
          error={error}
          onSearchChange={setSearchQuery}
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
              <Button appearance="secondary" onClick={() => setSettingsOpen(false)}>
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
