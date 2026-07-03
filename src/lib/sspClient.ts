import { invoke } from "@tauri-apps/api/core";
import { recordLaunch } from "./ghostDatabase";
import type { GhostView } from "../types";

export type LaunchTarget = Pick<GhostView, "directory_name" | "source" | "ghost_identity_key">;

/// launch_ghost IPC の唯一の入口。起動成功時に起動履歴を fire-and-forget で記録する。
export async function launchGhost(sspPath: string, ghost: LaunchTarget): Promise<void> {
  await invoke("launch_ghost", {
    sspPath,
    ghostDirectoryName: ghost.directory_name,
    ghostSource: ghost.source,
  });
  if (ghost.ghost_identity_key) {
    void recordLaunch(ghost.ghost_identity_key).catch(() => {});
  }
}

/// validate_ssp_path IPC の唯一の入口。
export async function validateSspPath(sspPath: string): Promise<void> {
  await invoke("validate_ssp_path", { sspPath });
}
