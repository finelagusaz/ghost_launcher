import { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dropdown, Option, Text, Tooltip, makeStyles, tokens } from "@fluentui/react-components";
import { ArrowShuffleRegular, SettingsRegular } from "@fluentui/react-icons";
import { GhostList } from "./GhostList";
import { SearchBox } from "./SearchBox";
import type { GhostView, SortOrder } from "../types";

interface Props {
  ghosts: GhostView[];
  total: number;
  loadedStart: number;
  sspPath: string | null;
  searchQuery: string;
  sortOrder: SortOrder;
  loading: boolean;
  searchLoading: boolean;
  error: string | null;
  onSearchChange: (value: string) => void;
  onSortChange: (value: SortOrder) => void;
  onRandomLaunch: () => Promise<void>;
  onOpenSettings: () => void;
  onLoadMore: (targetOffset: number) => void;
}

const SORT_OPTIONS: SortOrder[] = ["name", "recent", "frequency", "random"];

const useStyles = makeStyles({
  toolbar: {
    display: "flex",
    alignItems: "end",
    gap: "12px",
    flexWrap: "wrap",
  },
  searchWrapper: {
    flex: "1 1 auto",
    minWidth: "200px",
    maxWidth: "480px",
  },
  sortWrapper: {
    flex: "0 0 auto",
    minWidth: "140px",
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
  sortOrder,
  loading,
  searchLoading,
  error,
  onSearchChange,
  onSortChange,
  onRandomLaunch,
  onOpenSettings,
  onLoadMore,
}: Props) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [randomLaunching, setRandomLaunching] = useState(false);

  const handleRandomLaunch = useCallback(async () => {
    setRandomLaunching(true);
    try {
      await onRandomLaunch();
    } finally {
      setRandomLaunching(false);
    }
  }, [onRandomLaunch]);

  if (!sspPath) {
    return (
      <div className={styles.emptyState} data-testid="empty-state">
        <Text>{t("content.noSspPath")}</Text>
        <Button icon={<SettingsRegular />} appearance="outline" onClick={onOpenSettings} data-testid="open-settings-button">
          {t("content.openSettings")}
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className={styles.toolbar}>
        <div className={styles.searchWrapper}>
          <SearchBox value={searchQuery} onChange={onSearchChange} />
        </div>
        <div className={styles.sortWrapper}>
          <Dropdown
            aria-label={t("sort.label")}
            value={t(`sort.${sortOrder}`)}
            selectedOptions={[sortOrder]}
            onOptionSelect={(_, data) => {
              if (data.optionValue) onSortChange(data.optionValue as SortOrder);
            }}
          >
            {SORT_OPTIONS.map((opt) => (
              <Option key={opt} value={opt}>{t(`sort.${opt}`)}</Option>
            ))}
          </Dropdown>
        </div>
        <Tooltip content={t("header.randomLaunch")} relationship="label">
          <Button
            icon={<ArrowShuffleRegular />}
            appearance="subtle"
            onClick={handleRandomLaunch}
            disabled={loading || randomLaunching}
            data-testid="random-launch-button"
          />
        </Tooltip>
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
