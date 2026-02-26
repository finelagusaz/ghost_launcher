import { getGhostsFingerprint, scanGhostsWithMeta } from "./ghostScanClient";
import type { ScanGhostsResponse } from "../types";

const pendingScans = new Map<string, Promise<ScanGhostsResponse>>();

/**
 * キャッシュの fingerprint を検証する。
 * 一致なら true、不一致またはエラー時は false を返す。
 */
export async function validateCache(
  cachedFingerprint: string | null,
  sspPath: string,
  additionalFolders: string[],
): Promise<boolean> {
  if (!cachedFingerprint) return false;
  try {
    const fingerprint = await getGhostsFingerprint(sspPath, additionalFolders);
    return fingerprint === cachedFingerprint;
  } catch {
    // 指紋取得に失敗した場合はフルスキャンへフォールバックする。
    return false;
  }
}

/**
 * 重複排除付きでスキャンを実行する。
 * 同一 requestKey に対する並行リクエストは共有される。
 * forceFullScan 時は既存の pending を上書きする。
 */
export function executeScan(
  requestKey: string,
  sspPath: string,
  additionalFolders: string[],
  forceFullScan: boolean,
): Promise<ScanGhostsResponse> {
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
