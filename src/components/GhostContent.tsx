import { memo } from "react";
import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import { SettingsRegular } from "@fluentui/react-icons";
import { GhostList } from "./GhostList";
import { SearchBox } from "./SearchBox";
import type { GhostView } from "../types";

interface Props {
  ghosts: GhostView[];
  total: number;
  loadedStart: number;
  sspPath: string | null;
  searchQuery: string;
  loading: boolean;
  searchLoading: boolean;
  error: string | null;
  onSearchChange: (value: string) => void;
  onOpenSettings: () => void;
  onLoadMore: (targetOffset: number) => void;
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
  total,
  loadedStart,
  sspPath,
  searchQuery,
  loading,
  searchLoading,
  error,
  onSearchChange,
  onOpenSettings,
  onLoadMore,
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
        <GhostList
          ghosts={ghosts}
          total={total}
          loadedStart={loadedStart}
          sspPath={sspPath}
          loading={loading}
          searchLoading={searchLoading}
          error={error}
          onLoadMore={onLoadMore}
          searchQuery={searchQuery}
        />
      </div>
    </>
  );
});
