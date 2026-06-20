export function normalizePathKey(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").toLowerCase();
  if (/^[a-z]:\/$/i.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/g, "");
}

export function buildAdditionalFolders(folders: string[]): string[] {
  // ソート順は Rust 側（scan.rs の String::cmp）と一致させる必要がある。
  // request_key の書き込み（Rust）と読み出し（JS）でキーが食い違うと
  // 同じフォルダ構成でもクエリが 0 件になる。localeCompare はロケール依存で
  // '_'(0x5F) を '2'(0x32) より前に並べてしまうため、コードポイント順で比較する。
  const sorted = folders
    .map((folder) => ({ raw: folder, key: normalizePathKey(folder) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

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

export function formatErrorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message.trim() : String(error).trim();
  return detail ? `（詳細: ${detail}）` : "";
}

export function buildScanErrorMessage(error: unknown): string {
  return `ゴースト一覧の取得に失敗しました。SSPフォルダと追加フォルダを確認して「再読込」を実行してください。${formatErrorDetail(error)}`;
}
