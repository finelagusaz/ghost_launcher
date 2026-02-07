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
    maxWidth: "900px",
    margin: "0 auto",
    minHeight: "100vh",
    padding: "20px 16px 28px",
  },
  shell: {
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow16,
    backdropFilter: "blur(16px)",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    padding: "20px",
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
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: "12px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  title: {
    fontSize: tokens.fontSizeHero800,
    lineHeight: tokens.lineHeightHero800,
    fontWeight: tokens.fontWeightSemibold,
  },
  toolbar: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: "8px",
    alignItems: "stretch",
    "@media (max-width: 600px)": {
      gridTemplateColumns: "1fr",
    },
  },
  content: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
  },
  emptyState: {
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    boxShadow: tokens.shadow4,
    padding: "24px",
    textAlign: "center",
  },
  dialogSurface: {
    width: "min(860px, calc(100vw - 24px))",
    boxShadow: tokens.shadow64,
    backdropFilter: "blur(18px)",
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
          <Text as="h1" className={styles.title}>
            Ghost Launcher
          </Text>
          <Button
            icon={<SettingsRegular />}
            appearance="secondary"
            onClick={() => setSettingsOpen(true)}
          >
            設定
          </Button>
        </header>

        {sspPath && (
          <>
            <div className={styles.toolbar}>
              <SearchBox value={searchQuery} onChange={setSearchQuery} />
              <Button
                icon={<ArrowClockwiseRegular />}
                appearance="secondary"
                onClick={refresh}
                disabled={ghostsLoading}
              >
                再読込
              </Button>
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
