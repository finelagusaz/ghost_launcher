export function normalizePathKey(path: string): string {
  return path.trim().replace(/\\/g, "/").toLowerCase();
}

export function buildAdditionalFolders(folders: string[]): string[] {
  const sorted = folders
    .map((folder) => ({ raw: folder, key: normalizePathKey(folder) }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const unique: string[] = [];
  let lastKey: string | null = null;

  for (const folder of sorted) {
    if (folder.key === lastKey) {
      continue;
    }
    unique.push(folder.raw);
    lastKey = folder.key;
  }

  return unique;
}

export function buildRequestKey(sspPath: string, additionalFolders: string[]): string {
  const normalizedSspPath = normalizePathKey(sspPath);
  const normalizedFolders = additionalFolders.map((folder) => normalizePathKey(folder));
  return `${normalizedSspPath}::${normalizedFolders.join("|")}`;
}

export function buildScanErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message.trim() : String(error).trim();
  const detailText = detail ? `（詳細: ${detail}）` : "";
  return `ゴースト一覧の取得に失敗しました。SSPフォルダと追加フォルダを確認して「再読込」を実行してください。${detailText}`;
}
