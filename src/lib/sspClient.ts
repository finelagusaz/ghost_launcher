import { invoke } from "@tauri-apps/api/core";
import { recordLaunch } from "./ghostDatabase";
import type { GhostView } from "../types";

export type LaunchTarget = Pick<GhostView, "directory_name" | "source" | "ghost_identity_key">;

const launchRecordedListeners = new Set<() => void>();

/// 起動履歴の記録（ghosts の集計列の更新を含む）の成功を購読する。戻り値の関数で解除する。
/// 最近起動順・起動回数順の並びを取り直す合図に使う。通知は起動の成功時ではなく、記録の
/// 完了後に出す。起動の成功時に通知すると、集計列が更新される前に一覧を読み直し、古い並びを
/// 取得してしまうためである。記録に失敗したときは通知しない。
export function subscribeLaunchRecorded(listener: () => void): () => void {
  launchRecordedListeners.add(listener);
  return () => launchRecordedListeners.delete(listener);
}

/// launch_ghost IPC の唯一の入口（カード・Enter・ランダムの全起動経路がここを通る）。
/// 起動に成功したら起動履歴を fire-and-forget で記録し、記録の成功を購読者へ通知する。
export async function launchGhost(sspPath: string, ghost: LaunchTarget): Promise<void> {
  await invoke("launch_ghost", {
    sspPath,
    ghostDirectoryName: ghost.directory_name,
    ghostSource: ghost.source,
  });
  if (ghost.ghost_identity_key) {
    void recordLaunch(ghost.ghost_identity_key)
      .then(() => {
        for (const listener of launchRecordedListeners) listener();
      })
      .catch(() => {});
  }
}

/// validate_ssp_path IPC の唯一の入口。
export async function validateSspPath(sspPath: string): Promise<void> {
  await invoke("validate_ssp_path", { sspPath });
}
