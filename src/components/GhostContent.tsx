import { memo } from "react";
import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import { SettingsRegular } from "@fluentui/react-icons";
import { GhostList } from "./GhostList";
import { SearchBox } from "./SearchBox";
import type { GhostView } from "../types";

interface Props {
  ghosts: GhostView[];
  sspPath: string | null;
  searchQuery: string;
  loading: boolean;
  error: string | null;
  onSearchChange: (value: string) => void;
  onOpenSettings: () => void;
}

const useStyles = makeStyles({
  toolbar: {
    display: "block",
    width: "min(480px, 100%)",
    minWidth: 0,
  },
  content: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    minWidth: 0,
  },
  emptyState: {
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
    padding: "24px",
    textAlign: "center",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "12px",
  },
});

export const GhostContent = memo(function GhostContent({
  ghosts,
  sspPath,
  searchQuery,
  loading,
  error,
  onSearchChange,
  onOpenSettings,
}: Props) {
  const styles = useStyles();

  if (!sspPath) {
    return (
      <div className={styles.emptyState}>
        <Text>SSPフォルダを選択してください</Text>
        <Button icon={<SettingsRegular />} appearance="outline" onClick={onOpenSettings}>
          設定を開く
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className={styles.toolbar}>
        <SearchBox value={searchQuery} onChange={onSearchChange} />
      </div>
      <div className={styles.content}>
        <GhostList ghosts={ghosts} sspPath={sspPath} loading={loading} error={error} />
      </div>
    </>
  );
});
