import { Spinner, Text, makeStyles, tokens } from "@fluentui/react-components";
import { GhostCard } from "./GhostCard";
import type { Ghost } from "../types";

interface Props {
  ghosts: Ghost[];
  sspPath: string;
  loading: boolean;
  error: string | null;
}

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  count: {
    color: tokens.colorNeutralForeground3,
  },
  state: {
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    backdropFilter: "blur(10px)",
    padding: "24px",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
  },
});

export function GhostList({ ghosts, sspPath, loading, error }: Props) {
  const styles = useStyles();

  if (loading) {
    return (
      <div className={styles.state}>
        <Spinner label="読み込み中..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.state}>
        <Text className={styles.error}>{error}</Text>
      </div>
    );
  }

  if (ghosts.length === 0) {
    return (
      <div className={styles.state}>
        <Text>ゴーストが見つかりません</Text>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <Text className={styles.count}>{ghosts.length} 体のゴースト</Text>
      {ghosts.map((ghost) => (
        <GhostCard key={ghost.path} ghost={ghost} sspPath={sspPath} />
      ))}
    </div>
  );
}
