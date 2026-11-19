import { useCallback, useDeferredValue, useEffect, useState } from "react";
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
import { useDebouncedValue } from "./hooks/useDebouncedValue";
import { useAppShellState } from "./hooks/useAppShellState";
import { useLauncherToasts } from "./hooks/useLauncherToasts";
import { useGhostLauncher } from "./hooks/useGhostLauncher";
import { useScanIndicator } from "./hooks/useScanIndicator";
import { AppHeader } from "./components/AppHeader";
import { GhostContent } from "./components/GhostContent";
import { ScanProgressBar } from "./components/ScanProgressBar";
import { SettingsPanel } from "./components/SettingsPanel";
import ghostListConfig from "./config/ghost-list.json";
import { requestKeyFromSettings } from "./lib/ghostScanUtils";
import { formatErrorDetail, buildScanErrorMessage } from "./lib/errorMessages";
import { getRandomGhost, reseedRandomSort, sortDependsOnLaunchStats } from "./lib/ghostDatabase";
import { subscribeLaunchRecorded } from "./lib/sspClient";
import type { SortOrder } from "./types";

// 検索デバウンス幅。1 打鍵の間隔より長く、「入力を止めたら即結果」と感じる短さに保つ
const SEARCH_DEBOUNCE_MS = 150;

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
  const { notifyError, notifyWarning } = useLauncherToasts();
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
  const launch = useGhostLauncher(sspPath);
  const { loading: ghostsLoading, error, refresh } = useGhosts(sspPath, ghostFolders);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("name");
  // 同じ sortOrder のまま並び順が変わったことを useSearch と GhostContent に伝える epoch。
  // ランダム再選択のシード変更（reseedRandomSort() はモジュール変数を書き換えるだけ）と、
  // 最近起動順・起動回数順での起動記録（DB の集計列の更新）は、どちらも React の状態に
  // 現れない。sortEpoch を進めて、並びの取り直しを強制する
  const [sortEpoch, setSortEpoch] = useState(0);

  // 集計列で並べている間だけ起動の記録を購読し、記録のたびに並びを取り直す
  // （起動したゴーストが最近起動順の先頭へ上がる）。名前順・ランダム順の並びは起動で変わらない
  useEffect(() => {
    if (!sortDependsOnLaunchStats(sortOrder)) return;
    return subscribeLaunchRecorded(() => setSortEpoch((e) => e + 1));
  }, [sortOrder]);
  // タイピング中のクエリ発行を打鍵毎から区切り毎に合流させる（時間側の合流）。
  // useDeferredValue はレンダー優先度側の遅延で、役割が異なるため両方通す
  const debouncedSearchQuery = useDebouncedValue(searchQuery, SEARCH_DEBOUNCE_MS);
  const deferredSearchQuery = useDeferredValue(debouncedSearchQuery);
  // 一覧の 1 ページの件数。src/config/ghost-list.json が単一権威（ベンチと E2E も同じ値を読む）
  const LIMIT = ghostListConfig.pageLimit;

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
      // launch は内部で成功/失敗トーストまで処理する。ここの catch は
      // getRandomGhost（DB アクセス）失敗時のみに来る
      await launch(ghost);
    } catch (e) {
      notifyError(t("card.launchError", { detail: formatErrorDetail(e, t) }));
    }
  }, [searchRequestKey, sspPath, launch, t, notifyError, notifyWarning]);

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
  // キャッシュが無い場合のみエラーを表示する（SPEC 9 エラーハンドリング）。
  // 文言は描画時に組み立てる（言語を切り替えたら表示中のエラーも切り替わる）
  const hasCachedDisplay = searchResultGhosts.length > 0 || searchTotal > 0;
  const scanError = hasCachedDisplay || error === null ? null : buildScanErrorMessage(error.cause, t);

  // 再スキャン中（既に一覧が見えている状態）のみ非確定バーを出す。初回（一覧なし）は
  // 全画面スピナー（GhostList）に委ねるため hasCachedDisplay で排他にする。
  const showScanBar = useScanIndicator(ghostsLoading && hasCachedDisplay);

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
        <ScanProgressBar visible={showScanBar} />
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
          sortEpoch={sortEpoch}
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
