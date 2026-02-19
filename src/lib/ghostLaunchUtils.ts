export function getSourceFolderLabel(source: string): string {
  return source.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || source;
}

import { formatErrorDetail } from "./ghostScanUtils";

export function buildLaunchErrorMessage(error: unknown): string {
  return `起動に失敗しました。SSPフォルダ設定とゴースト情報を確認して、再度お試しください。${formatErrorDetail(error)}`;
}
