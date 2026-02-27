import { useEffect, useRef } from "react";
import { Spinner, Text, makeStyles, tokens } from "@fluentui/react-components";
import { GhostCard } from "./GhostCard";
import { SkeletonCard } from "./SkeletonCard";
import { useElementHeight } from "../hooks/useElementHeight";
import { useVirtualizedList } from "../hooks/useVirtualizedList";
import type { GhostView } from "../types";

interface Props {
  ghosts: GhostView[];
  total: number;
  loadedStart: number;
  sspPath: string;
  searchQuery: string;
  loading: boolean;
  searchLoading: boolean;
  error: string | null;
  onLoadMore: (targetOffset: number) => void;
}

const ESTIMATED_ROW_HEIGHT = 100;
const STACK_GAP = 8;
const OVERSCAN_ROWS = 6;
const DEFAULT_VIEWPORT_HEIGHT = 420;
const FETCH_DEBOUNCE_MS = 80;
// 読込ウィンドウの前後パディング（表示範囲より余裕を持って読み込む）
const WINDOW_PADDING = 100;
// 読込済み範囲の端からこの距離以内に表示範囲が近づいたら先読みを開始する
const PREFETCH_THRESHOLD = 100;

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
    scrollbarGutter: "stable",
    padding: "4px 0",
  },
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: `${STACK_GAP}px`,
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

export function GhostList({ ghosts, total, loadedStart, sspPath, searchQuery, loading, searchLoading, error, onLoadMore }: Props) {
  const styles = useStyles();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  // 検索クエリ変更→スクロール位置をトップに戻す
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && viewport.scrollTop !== 0) {
      viewport.scrollTop = 0;
    }
  }, [searchQuery]);

  const shouldVirtualize = total >= 80;
  const viewportHeight = useElementHeight(viewportRef, shouldVirtualize, DEFAULT_VIEWPORT_HEIGHT);

  const { startIndex, endIndex, topSpacer, bottomSpacer, onScroll } = useVirtualizedList(
    ghosts,
    {
      viewportHeight,
      estimatedRowHeight: ESTIMATED_ROW_HEIGHT,
      overscanRows: OVERSCAN_ROWS,
      gap: STACK_GAP,
      totalCount: total,
    },
  );

  // 表示範囲が読込済み範囲外になったら debounce して fetch
  const loadedEnd = loadedStart + ghosts.length;
  useEffect(() => {
    if (!shouldVirtualize || total === 0 || searchLoading) return;

    const needsLoad =
      startIndex < loadedStart + PREFETCH_THRESHOLD ||
      endIndex > loadedEnd - PREFETCH_THRESHOLD;
    if (!needsLoad) return;

    const timer = setTimeout(() => {
      const targetOffset = Math.max(0, startIndex - WINDOW_PADDING);
      onLoadMoreRef.current(targetOffset);
    }, FETCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [startIndex, endIndex, loadedStart, loadedEnd, shouldVirtualize, total, searchLoading]);

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

  if (total === 0 && ghosts.length === 0) {
    return (
      <div className={styles.state}>
        <Text>ゴーストが見つかりません</Text>
      </div>
    );
  }

  // 仮想化しない場合は全件表示
  if (!shouldVirtualize) {
    return (
      <div className={styles.root}>
        <Text className={styles.count} aria-live="polite">
          {total} 体のゴースト
        </Text>
        <div className={styles.viewport} ref={viewportRef}>
          <div className={styles.stack}>
            {ghosts.map((ghost) => (
              <GhostCard key={ghost.path} ghost={ghost} sspPath={sspPath} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // 仮想化モード: グローバルインデックス startIndex ~ endIndex をループし、
  // 読込済み範囲内なら GhostCard、範囲外なら SkeletonCard を描画
  const cards: React.ReactNode[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    if (i >= loadedStart && i < loadedEnd) {
      const ghost = ghosts[i - loadedStart];
      cards.push(<GhostCard key={ghost.path} ghost={ghost} sspPath={sspPath} />);
    } else {
      cards.push(<SkeletonCard key={`skeleton-${i}`} />);
    }
  }

  return (
    <div className={styles.root}>
      <Text className={styles.count} aria-live="polite">
        {total} 体のゴースト
      </Text>
      <div
        className={styles.viewport}
        ref={viewportRef}
        onScroll={onScroll}
      >
        <div style={{ height: topSpacer }} />
        <div className={styles.stack}>
          {cards}
        </div>
        <div style={{ height: bottomSpacer }} />
      </div>
    </div>
  );
}
