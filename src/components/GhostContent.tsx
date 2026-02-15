import { Text, makeStyles, tokens } from "@fluentui/react-components";
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
  },
});

export function GhostContent({
  ghosts,
  sspPath,
  searchQuery,
  loading,
  error,
  onSearchChange,
}: Props) {
  const styles = useStyles();

  if (!sspPath) {
    return (
      <div className={styles.emptyState}>
        <Text>SSPフォルダを選択してください</Text>
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
}
