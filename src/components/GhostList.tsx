import { useEffect, useRef } from "react";
import { Spinner, Text, makeStyles, tokens } from "@fluentui/react-components";
import { GhostCard } from "./GhostCard";
import { useElementHeight } from "../hooks/useElementHeight";
import { useVirtualizedList } from "../hooks/useVirtualizedList";
import type { GhostView } from "../types";

interface Props {
  ghosts: GhostView[];
  total: number;
  sspPath: string;
  searchQuery: string;
  loading: boolean;
  searchLoading: boolean;
  error: string | null;
  onLoadMore: () => void;
}

const VIRTUALIZE_THRESHOLD = 80;
const ESTIMATED_ROW_HEIGHT = 100;
const STACK_GAP = 8;
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

export function GhostList({ ghosts, total, sspPath, searchQuery, loading, searchLoading, error, onLoadMore }: Props) {
  const styles = useStyles();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  // センチネルを表示するかどうか（まだ読み込める件数が残っている場合のみ）
  const hasMore = ghosts.length < total;

  // 検索クエリ変更→スクロール位置をトップに戻す
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && viewport.scrollTop !== 0) {
      viewport.scrollTop = 0;
    }
  }, [searchQuery]);

  // IntersectionObserver でセンチネル要素を監視して追加読み込みをトリガー
  // スクロールイベントと完全に分離することでカード選択との干渉を防ぐ
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          onLoadMoreRef.current();
        }
      },
      {
        root: viewportRef.current,
        rootMargin: "200px",
        threshold: 0,
      }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
    // hasMore が false→true（初回ロード完了）で observer を作成し、
    // true→false（全件ロード完了）で cleanup する。
    // ghosts.length を含めると追加読み込みのたびに observer が再生成され
    // 即座にコールバックが発火するカスケードが起きるため含めない。
  }, [hasMore]);

  const shouldVirtualize = ghosts.length >= VIRTUALIZE_THRESHOLD;
  const viewportHeight = useElementHeight(viewportRef, shouldVirtualize, DEFAULT_VIEWPORT_HEIGHT);

  const { visibleItems: visibleGhosts, topSpacer, bottomSpacer, onScroll } = useVirtualizedList(
    ghosts,
    {
      viewportHeight,
      estimatedRowHeight: ESTIMATED_ROW_HEIGHT,
      overscanRows: OVERSCAN_ROWS,
      gap: STACK_GAP,
    },
  );


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

  return (
    <div className={styles.root}>
      <Text className={styles.count} aria-live="polite">
        {total} 体のゴースト
      </Text>
      <div
        className={styles.viewport}
        ref={viewportRef}
        onScroll={shouldVirtualize ? onScroll : undefined}
      >
        {shouldVirtualize && <div style={{ height: topSpacer }} />}
        <div className={styles.stack}>
          {(shouldVirtualize ? visibleGhosts : ghosts).length > 0 ? (
            (shouldVirtualize ? visibleGhosts : ghosts).map((ghost) => (
              <GhostCard key={ghost.path} ghost={ghost} sspPath={sspPath} />
            ))
          ) : hasMore ? (
            <div style={{ textAlign: "center", padding: "16px 0" }}>
              <Spinner size="small" label="読み込み中..." />
            </div>
          ) : null}
        </div>
        {shouldVirtualize && <div style={{ height: bottomSpacer }} />}

        {/* センチネル要素：読込済み領域の末尾に配置し追加読み込みをトリガー */}
        {hasMore && <div ref={sentinelRef} style={{ height: 1 }} />}

        {/* 追加読み込み中スピナー */}
        {searchLoading && ghosts.length > 0 && (
          <div style={{ textAlign: "center", padding: "16px 0" }}>
            <Spinner size="small" />
          </div>
        )}
      </div>
    </div>
  );
}
