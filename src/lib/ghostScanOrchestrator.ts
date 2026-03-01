import { scanGhostsWithMeta } from "./ghostScanClient";
import type { ScanGhostsResponse } from "../types";

const pendingScans = new Map<string, Promise<ScanGhostsResponse>>();

export interface ExecuteScanParams {
  requestKey: string;
  sspPath: string;
  additionalFolders: string[];
  forceFullScan: boolean;
}

/**
 * 重複排除付きでスキャンを実行する。
 * 同一 requestKey に対する並行リクエストは共有される。
 * forceFullScan 時は既存の pending を上書きする。
 */
export function executeScan({
  requestKey,
  sspPath,
  additionalFolders,
  forceFullScan,
}: ExecuteScanParams): Promise<ScanGhostsResponse> {
  let scanPromise = pendingScans.get(requestKey);
  if (!scanPromise || forceFullScan) {
    scanPromise = scanGhostsWithMeta(sspPath, additionalFolders);

    pendingScans.set(requestKey, scanPromise);
    scanPromise.finally(() => {
      if (pendingScans.get(requestKey) === scanPromise) {
        pendingScans.delete(requestKey);
      }
    });
  }
  return scanPromise;
}
