import { scanGhostsWithMeta } from "./ghostScanClient";
import type { ScanGhostsResponse } from "../types";

const pendingScans = new Map<string, Promise<ScanGhostsResponse>>();

export interface ExecuteScanParams {
  requestKey: string;
  sspPath: string;
  additionalFolders: string[];
  forceFullScan: boolean;
  cachedFingerprint: string | null;
}

/**
 * 重複排除付きでスキャンを実行する。
 * 同一 requestKey に対する並行リクエストは共有される。
 * forceFullScan 時はキャッシュ一致時でも必ず再取得する。
 */
export function executeScan({
  requestKey,
  sspPath,
  additionalFolders,
  forceFullScan,
  cachedFingerprint,
}: ExecuteScanParams): Promise<ScanGhostsResponse> {
  let scanPromise = pendingScans.get(requestKey);
  if (!scanPromise || forceFullScan) {
    scanPromise = scanGhostsWithMeta(sspPath, additionalFolders).then((result) => {
      if (!forceFullScan && cachedFingerprint && result.fingerprint === cachedFingerprint) {
        return { ...result, ghosts: [] };
      }
      return result;
    });

    pendingScans.set(requestKey, scanPromise);
    scanPromise.finally(() => {
      if (pendingScans.get(requestKey) === scanPromise) {
        pendingScans.delete(requestKey);
      }
    });
  }
  return scanPromise;
}
