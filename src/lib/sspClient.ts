import { invoke } from "@tauri-apps/api/core";
import { recordLaunch } from "./ghostDatabase";
import type { GhostView } from "../types";

export type LaunchTarget = Pick<GhostView, "directory_name" | "source" | "ghost_identity_key">;

const launchRecordedListeners = new Set<() => void>();

/// 起動履歴の記録（ghosts の集計列の更新を含む）が成功したことを購読する。戻り値で解除する。
/// 最近起動順・起動回数順の並びを取り直す合図に使う。起動の成功時点ではなく記録の完了後に
/// 通知するのは、集計列の更新より先に一覧を読み直して古い並びを掴まないため。
export function subscribeLaunchRecorded(listener: () => void): () => void {
  launchRecordedListeners.add(listener);
  return () => {
    launchRecordedListeners.delete(listener);
  };
}

/// launch_ghost IPC の唯一の入口。起動成功時に起動履歴を fire-and-forget で記録し、
/// 記録が成功したら購読者へ通知する（カード・Enter・ランダムの全起動経路がここを通る）。
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
