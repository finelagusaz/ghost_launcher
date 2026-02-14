import { useEffect, useRef, useState } from "react";
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
const DEFAULT_VIEWPORT_HEIGHT = 420;

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  viewport: {
    maxHeight: "60vh",
    minHeight: "240px",
    overflowY: "auto",
    padding: "8px",
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  count: {
    color: tokens.colorNeutralForeground3,
  },
  state: {
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
    padding: "24px",
    minHeight: "140px",
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
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setScrollTop(0);
    const viewport = viewportRef.current;
    if (viewport && viewport.scrollTop !== 0) {
      viewport.scrollTop = 0;
    }
  }, [ghosts]);

  useEffect(() => {
    if (ghosts.length < VIRTUALIZE_THRESHOLD) {
      return;
    }

    const element = viewportRef.current;
    if (!element) {
      return;
    }

    const updateHeight = () => {
      const nextHeight = element.clientHeight;
      if (nextHeight > 0) {
        setViewportHeight((prev) => (prev === nextHeight ? prev : nextHeight));
      }
    };

    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      updateHeight();
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [ghosts.length]);

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
        <Text role="alert" className={styles.error}>
          {error}
        </Text>
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
        <Text className={styles.count} aria-live="polite">
          {ghosts.length} 体のゴースト
        </Text>
        <div className={styles.stack}>
          {ghosts.map((ghost) => (
            <GhostCard key={ghost.path} ghost={ghost} sspPath={sspPath} />
          ))}
        </div>
      </div>
    );
  }

  const visibleRowCount = Math.max(1, Math.ceil(viewportHeight / ESTIMATED_ROW_HEIGHT));
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
      <Text className={styles.count} aria-live="polite">
        {ghosts.length} 体のゴースト
      </Text>
      <div
        className={styles.viewport}
        ref={viewportRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
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
