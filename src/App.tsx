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
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ArrowClockwiseRegular, SettingsRegular } from "@fluentui/react-icons";
import { useSettings } from "./hooks/useSettings";
import { useGhosts } from "./hooks/useGhosts";
import { useSearch } from "./hooks/useSearch";
import { SettingsPanel } from "./components/SettingsPanel";
import { SearchBox } from "./components/SearchBox";
import { GhostList } from "./components/GhostList";

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
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "12px",
    paddingBottom: "16px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    "@media (max-width: 600px)": {
      flexDirection: "column",
      alignItems: "stretch",
    },
  },
  titleBlock: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  headerActions: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
    "@media (max-width: 600px)": {
      justifyContent: "flex-start",
    },
  },
  title: {
    fontSize: tokens.fontSizeBase600,
    lineHeight: tokens.lineHeightBase600,
    fontWeight: tokens.fontWeightSemibold,
  },
  subtitle: {
    color: tokens.colorNeutralForeground3,
  },
  toolbar: {
    display: "block",
  },
  content: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  emptyState: {
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
    padding: "24px",
    textAlign: "center",
  },
  dialogSurface: {
    width: "min(760px, calc(100vw - 24px))",
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
        <header className={styles.header}>
          <div className={styles.titleBlock}>
            <Text as="h1" className={styles.title}>
              Ghost Launcher
            </Text>
          </div>
          <div className={styles.headerActions}>
            {sspPath && (
              <Button
                icon={<ArrowClockwiseRegular />}
                appearance="secondary"
                onClick={refresh}
                disabled={ghostsLoading}
              >
                再読込
              </Button>
            )}
            <Button
              icon={<SettingsRegular />}
              appearance="secondary"
              onClick={() => setSettingsOpen(true)}
            >
              設定
            </Button>
          </div>
        </header>

        {sspPath && (
          <>
            <div className={styles.toolbar}>
              <SearchBox value={searchQuery} onChange={setSearchQuery} />
            </div>
            <div className={styles.content}>
              <GhostList
                ghosts={filteredGhosts}
                sspPath={sspPath}
                loading={ghostsLoading}
                error={error}
              />
            </div>
          </>
        )}

        {!sspPath && (
          <div className={styles.emptyState}>
            <Text>SSPフォルダを選択してください</Text>
          </div>
        )}
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
