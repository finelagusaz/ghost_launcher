export function getSourceFolderLabel(source: string): string {
  return source.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || source;
}

export function buildLaunchErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message.trim() : String(error).trim();
  const detailText = detail ? `（詳細: ${detail}）` : "";
  return `起動に失敗しました。SSPフォルダ設定とゴースト情報を確認して、再度お試しください。${detailText}`;
}
