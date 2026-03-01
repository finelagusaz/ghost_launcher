import { invoke } from "@tauri-apps/api/core";
import type { ScanGhostsResponse } from "../types";

export async function scanGhostsWithMeta(
  sspPath: string,
  additionalFolders: string[],
): Promise<ScanGhostsResponse> {
  return invoke<ScanGhostsResponse>("scan_ghosts_with_meta", {
    sspPath,
    additionalFolders,
  });
}
