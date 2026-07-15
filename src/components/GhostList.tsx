import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button, Spinner, Text, makeStyles, tokens } from "@fluentui/react-components";
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
  selectedIndex: number;
  // 起動対象ハイライトを表示するか（検索欄フォーカス中のみ true）
  selectionVisible: boolean;
  // 検索0件の空表示から検索をクリアする
  onClearSearch: () => void;
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
  emptyContent: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "12px",
  },
});

export function GhostList({ ghosts, total, loadedStart, sspPath, searchQuery, loading, searchLoading, error, onLoadMore, selectedIndex, selectionVisible, onClearSearch }: Props) {
  const styles = useStyles();
  const { t } = useTranslation();
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

  // 選択行を viewport 内へスクロールする（nearest）。仮想化時は選択行が DOM に無い
  // ことがあり scrollIntoView が使えないため、index から scrollTop を算出して代入する。
  // 代入により onScroll が発火し、仮想ウィンドウが再計算されて対象行が描画される。
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rowHeight = ESTIMATED_ROW_HEIGHT + STACK_GAP;
    const top = selectedIndex * rowHeight;
    const bottom = top + rowHeight;
    if (top < viewport.scrollTop) {
      viewport.scrollTop = top;
    } else if (bottom > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = bottom - viewport.clientHeight;
    }
  }, [selectedIndex]);

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

  // スキャン中でも表示可能なキャッシュがあれば一覧を維持する（stale-while-revalidate）。
  // 表示するゴーストが無いときのみスピナーを出す。初回ロードや再検索の解決中
  // （searchLoading）にキャッシュが空でも、空表示（0件）を早合点しないようスピナーで待つ
  if ((loading || searchLoading) && total === 0 && ghosts.length === 0) {
    return (
      <div className={styles.state}>
        <Spinner label={t("list.loading")} />
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
    // 「検索で0件」と「そもそもゴースト0体」を描き分ける。前者は次の一手
    // （検索クリア）を添える
    const query = searchQuery.trim();
    return (
      <div className={styles.state} data-testid="empty-state">
        {query ? (
          <div className={styles.emptyContent}>
            <Text>{t("list.emptySearch", { query })}</Text>
            <Button appearance="secondary" onClick={onClearSearch}>
              {t("list.clearSearch")}
            </Button>
          </div>
        ) : (
          <Text>{t("list.empty")}</Text>
        )}
      </div>
    );
  }

  // 仮想化しない場合は全件表示
  if (!shouldVirtualize) {
    return (
      <div className={styles.root}>
        <Text className={styles.count} aria-live="polite">
          {t("list.count", { count: total })}
        </Text>
        <div className={styles.viewport} ref={viewportRef} data-testid="ghost-list-viewport">
          <div className={styles.stack}>
            {ghosts.map((ghost, idx) => (
              <GhostCard
                key={ghost.path}
                ghost={ghost}
                sspPath={sspPath}
                selected={selectionVisible && loadedStart + idx === selectedIndex}
              />
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
      cards.push(<GhostCard key={ghost.path} ghost={ghost} sspPath={sspPath} selected={selectionVisible && i === selectedIndex} />);
    } else {
      cards.push(<SkeletonCard key={`skeleton-${i}`} />);
    }
  }

  return (
    <div className={styles.root}>
      <Text className={styles.count} aria-live="polite">
        {t("list.count", { count: total })}
      </Text>
      <div
        className={styles.viewport}
        ref={viewportRef}
        onScroll={onScroll}
        data-testid="ghost-list-viewport"
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
