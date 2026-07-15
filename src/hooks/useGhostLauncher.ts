import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { launchGhost } from "../lib/sspClient";
import { formatErrorDetail } from "../lib/ghostScanUtils";
import { useLauncherToasts } from "./useLauncherToasts";
import type { GhostView } from "../types";

// ゴースト起動をトーストフィードバック付きで実行する共有ランチャ。
// ボタン等の文脈を持たない起動経路（ランダム起動・一覧の Enter 起動）で使う。
// カード個別起動はボタン状態＋カード内インラインエラーを持つため対象外。
export function useGhostLauncher(sspPath: string | null) {
  const { t } = useTranslation();
  const { notifySuccess, notifyError } = useLauncherToasts();

  return useCallback(
    async (ghost: GhostView) => {
      if (!sspPath) return;
      try {
        await launchGhost(sspPath, ghost);
        notifySuccess(t("card.launchSuccess", { name: ghost.name }));
      } catch (e) {
        notifyError(t("card.launchError", { detail: formatErrorDetail(e) }));
      }
    },
    [sspPath, t, notifySuccess, notifyError],
  );
}
