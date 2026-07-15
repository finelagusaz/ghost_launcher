import { useCallback, useDeferredValue, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Spinner,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { useSettings } from "./hooks/useSettings";
import { useGhosts } from "./hooks/useGhosts";
import { useSearch } from "./hooks/useSearch";
import { useAppShellState } from "./hooks/useAppShellState";
import { useLauncherToasts } from "./hooks/useLauncherToasts";
import { AppHeader } from "./components/AppHeader";
import { GhostContent } from "./components/GhostContent";
import { SettingsPanel } from "./components/SettingsPanel";
import { requestKeyFromSettings, formatErrorDetail } from "./lib/ghostScanUtils";
import { getRandomGhost, reseedRandomSort } from "./lib/ghostDatabase";
import { launchGhost } from "./lib/sspClient";
import type { SortOrder } from "./types";

const useStyles = makeStyles({
  app: {
    maxWidth: "960px",
    margin: "0 auto",
    minHeight: "100vh",
    padding: "24px 20px 32px",
    "@media (max-width: 600px)": {
      padding: "16px 12px 24px",
    },
  },
  shell: {
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    padding: "24px",
    minWidth: 0,
    overflowX: "hidden",
    "@media (max-width: 600px)": {
      padding: "16px",
    },
  },
  loading: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  dialogSurface: {
    width: "min(760px, calc(100% - 24px))",
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow16,
  },
});

function App() {
  const styles = useStyles();
  const { t } = useTranslation();
  const { notifySuccess, notifyError, notifyWarning } = useLauncherToasts();
  const {
    sspPath,
    saveSspPath,
    ghostFolders,
    addGhostFolder,
    removeGhostFolder,
    language,
    saveLanguage,
    loading: settingsLoading,
    languageApplying,
  } = useSettings();
  const { loading: ghostsLoading, error, refresh } = useGhosts(sspPath, ghostFolders);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("name");
  // ランダム再選択でシードを引き直したことを useSearch に伝える epoch。
  // reseedRandomSort() 自体はモジュール変数の変更のみで React から不可視のため、
  // これを resetKey に含めて全置換フェッチを強制する（App.tsx#handleSortChange 参照）
  const [sortEpoch, setSortEpoch] = useState(0);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const LIMIT = 500;

  const {
    settingsOpen,
    setSettingsOpen,
    openSettings,
    closeSettings,
    offset,
    setOffset,
    refreshTrigger,
  } = useAppShellState({
    settingsLoading,
    sspPath,
    deferredSearchQuery,
    ghostsLoading,
  });

  // キャッシュ即時表示（stale-while-revalidate）: sspPath 確定時点で DB を引き、
  // 初回スキャン完了（refreshTrigger の増加）で再クエリして最新へ差し替える
  const searchRequestKey = sspPath
    ? requestKeyFromSettings(sspPath, ghostFolders)
    : null;

  const { ghosts: searchResultGhosts, total: searchTotal, loadedStart, loading: searchLoading, dbError } = useSearch(
    searchRequestKey,
    deferredSearchQuery,
    LIMIT,
    offset,
    refreshTrigger,
    sortOrder,
    sortEpoch,
  );

  const handleLoadMore = useCallback((targetOffset: number) => {
    if (!searchLoading) {
      setOffset(targetOffset);
    }
  }, [searchLoading, setOffset]);

  const handleRefresh = useCallback(() => refresh({ forceFullScan: true }), [refresh]);
  const handleOpenSettings = openSettings;
  const handleCloseSettings = closeSettings;

  const handleRandomLaunch = useCallback(async () => {
    if (!searchRequestKey || !sspPath) return;
    try {
      const ghost = await getRandomGhost(searchRequestKey);
      if (!ghost) {
        notifyWarning(t("header.randomLaunch.empty"));
        return;
      }
      await launchGhost(sspPath, ghost);
      notifySuccess(t("card.launchSuccess", { name: ghost.name }));
    } catch (e) {
      notifyError(t("card.launchError", { detail: formatErrorDetail(e) }));
    }
  }, [searchRequestKey, sspPath, t, notifySuccess, notifyError, notifyWarning]);

  const handleSortChange = useCallback((value: SortOrder) => {
    // 「ランダム」を選ぶたびに並びを引き直す。同値再選択は sortOrder/offset が
    // 変わらず effect が再実行されないため、sortEpoch を進めて可視状態として配線する
    if (value === "random") {
      reseedRandomSort();
      setSortEpoch((e) => e + 1);
    }
    setSortOrder(value);
    setOffset(0);
  }, [setOffset]);

  // キャッシュ表示中（ゴーストあり）はスキャンエラーを抑制し、表示を維持する。
  // キャッシュが無い場合のみエラーを表示する（SPEC 9 エラーハンドリング）
  const hasCachedDisplay = searchResultGhosts.length > 0 || searchTotal > 0;
  const scanError = hasCachedDisplay ? null : error;

  if (settingsLoading) {
    return (
      <div className={styles.loading}>
        <Spinner label={t("app.loading")} />
      </div>
    );
  }

  return (
    <div className={styles.app}>
      <div className={styles.shell}>
        <AppHeader
          sspPath={sspPath}
          ghostsLoading={ghostsLoading}
          onRefresh={handleRefresh}
          onOpenSettings={handleOpenSettings}
        />
        <GhostContent
          ghosts={searchResultGhosts}
          total={searchTotal}
          loadedStart={loadedStart}
          sspPath={sspPath}
          searchQuery={searchQuery}
          sortOrder={sortOrder}
          loading={ghostsLoading}
          searchLoading={searchLoading}
          error={scanError ?? dbError}
          onSearchChange={setSearchQuery}
          onSortChange={handleSortChange}
          onRandomLaunch={handleRandomLaunch}
          onOpenSettings={handleOpenSettings}
          onLoadMore={handleLoadMore}
        />
      </div>

      <Dialog
        modalType="modal"
        open={settingsOpen}
        onOpenChange={(_: unknown, data: { open: boolean }) => setSettingsOpen(data.open)}
      >
        <DialogSurface className={styles.dialogSurface}>
          <DialogBody>
            <DialogTitle>{t("app.settings.title")}</DialogTitle>
            <DialogContent>
              <SettingsPanel
                sspPath={sspPath}
                onPathChange={saveSspPath}
                ghostFolders={ghostFolders}
                onAddFolder={addGhostFolder}
                onRemoveFolder={removeGhostFolder}
                language={language}
                onLanguageChange={saveLanguage}
                languageApplying={languageApplying}
              />
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={handleCloseSettings} data-testid="settings-close-button">
                {t("app.settings.close")}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

export default App;
