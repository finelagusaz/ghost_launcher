import { useState } from "react";
import { Spinner, Text, makeStyles, tokens } from "@fluentui/react-components";
import { GhostCard } from "./GhostCard";
import type { Ghost } from "../types";

interface Props {
  ghosts: Ghost[];
  sspPath: string;
  loading: boolean;
  error: string | null;
}

const VIRTUALIZE_THRESHOLD = 80;
const ESTIMATED_ROW_HEIGHT = 100;
const OVERSCAN_ROWS = 6;

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  viewport: {
    maxHeight: "62vh",
    minHeight: "220px",
    overflowY: "auto",
    paddingRight: "2px",
  },
  stack: {
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
  const [scrollTop, setScrollTop] = useState(0);

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

  if (ghosts.length < VIRTUALIZE_THRESHOLD) {
    return (
      <div className={styles.root}>
        <Text className={styles.count}>{ghosts.length} 体のゴースト</Text>
        <div className={styles.stack}>
          {ghosts.map((ghost) => (
            <GhostCard key={ghost.path} ghost={ghost} sspPath={sspPath} />
          ))}
        </div>
      </div>
    );
  }

  const viewportHeight = window.innerHeight * 0.62;
  const visibleRowCount = Math.ceil(viewportHeight / ESTIMATED_ROW_HEIGHT);
  const startIndex = Math.max(0, Math.floor(scrollTop / ESTIMATED_ROW_HEIGHT) - OVERSCAN_ROWS);
  const endIndex = Math.min(
    ghosts.length,
    startIndex + visibleRowCount + OVERSCAN_ROWS * 2,
  );

  const totalHeight = ghosts.length * ESTIMATED_ROW_HEIGHT;
  const topSpacer = startIndex * ESTIMATED_ROW_HEIGHT;
  const visibleGhosts = ghosts.slice(startIndex, endIndex);
  const bottomSpacer = Math.max(
    0,
    totalHeight - topSpacer - visibleGhosts.length * ESTIMATED_ROW_HEIGHT,
  );

  return (
    <div className={styles.root}>
      <Text className={styles.count}>{ghosts.length} 体のゴースト</Text>
      <div className={styles.viewport} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        <div style={{ height: topSpacer }} />
        <div className={styles.stack}>
          {visibleGhosts.map((ghost) => (
            <GhostCard key={ghost.path} ghost={ghost} sspPath={sspPath} />
          ))}
        </div>
        <div style={{ height: bottomSpacer }} />
      </div>
    </div>
  );
}
