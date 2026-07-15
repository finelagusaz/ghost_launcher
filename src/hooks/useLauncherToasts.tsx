import { useCallback } from "react";
import { Toast, ToastTitle, useToastController } from "@fluentui/react-components";

// アプリ全体で唯一のトースター。main.tsx の <Toaster> と ID を共有する
export const TOASTER_ID = "ghost-launcher-toaster";

// intent ごとの表示時間（ms）。エラーは読み取りに余裕を持たせて長めにする
const TIMEOUTS = { success: 3000, warning: 4000, error: 6000 } as const;

type Intent = keyof typeof TIMEOUTS;

interface LauncherToasts {
  notifySuccess: (title: string) => void;
  notifyError: (title: string) => void;
  notifyWarning: (title: string) => void;
}

// 起動などの一過性の結果をトーストで通知するフック。
// 一覧（主要コンテンツ）を破壊せずに成功/失敗/警告を伝える
export function useLauncherToasts(): LauncherToasts {
  const { dispatchToast } = useToastController(TOASTER_ID);

  const notify = useCallback(
    (title: string, intent: Intent) => {
      dispatchToast(
        <Toast>
          <ToastTitle>{title}</ToastTitle>
        </Toast>,
        { intent, timeout: TIMEOUTS[intent] },
      );
    },
    [dispatchToast],
  );

  return {
    notifySuccess: useCallback((title: string) => notify(title, "success"), [notify]),
    notifyError: useCallback((title: string) => notify(title, "error"), [notify]),
    notifyWarning: useCallback((title: string) => notify(title, "warning"), [notify]),
  };
}
