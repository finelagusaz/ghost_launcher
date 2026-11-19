export function normalizePathKey(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").toLowerCase();
  if (/^[a-z]:\/$/i.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/g, "");
}

export function buildAdditionalFolders(folders: string[]): string[] {
  // ソート順は JS 内部で決定的であればよい（Lv1 で request_key は JS 単一権威）。
  // localeCompare はロケール依存で '_'(0x5F) を '2'(0x32) より前に並べ、環境差を
  // 生むため使わない。コードポイント順（UTF-16 コードユニット順）で比較する。
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

/// スキャン入力（正規化済み追加フォルダ + request_key）を設定値から組み立てる単一の入口。
/// additionalFolders と requestKey を別々に組み立てると不一致事故の温床になる
/// （過去障害: request_key 二重計算でゴースト一覧が空表示）。
export function scanInputsFromSettings(
  sspPath: string,
  ghostFolders: string[],
): { additionalFolders: string[]; requestKey: string } {
  const additionalFolders = buildAdditionalFolders(ghostFolders);
  return { additionalFolders, requestKey: buildRequestKey(sspPath, additionalFolders) };
}

/// 設定値から request_key のみが必要な場合の入口。scanInputsFromSettings へ委譲する。
export function requestKeyFromSettings(sspPath: string, ghostFolders: string[]): string {
  return scanInputsFromSettings(sspPath, ghostFolders).requestKey;
}

/// 追加フォルダとして登録できない理由。
/// - duplicate: 表記（大文字小文字・区切り文字・末尾の区切り）だけが違う登録済みのフォルダがある
/// - sspGhostFolder: SSP の ghost フォルダ自体。SSP のゴーストとして既に一覧に入るため、
///   追加すると同じゴーストが 2 体並ぶ
export type FolderRejectReason = "duplicate" | "sspGhostFolder";

/// 新しい追加フォルダを登録できない理由を返す（登録できるなら null）。
/// 比較はスキャンと同じ normalizePathKey で行う。
export function rejectReasonForNewFolder(
  folder: string,
  existing: string[],
  sspPath: string | null,
): FolderRejectReason | null {
  const key = normalizePathKey(folder);
  if (existing.some((registered) => normalizePathKey(registered) === key)) {
    return "duplicate";
  }
  if (sspPath && normalizePathKey(`${sspPath}/ghost`) === key) {
    return "sspGhostFolder";
  }
  return null;
}
