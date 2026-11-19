import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/// 試験用 SSP の場所を、globalSetup からテストへ渡す環境変数。
export const FIXTURE_SSP_ENV = "GHOST_LAUNCHER_E2E_FIXTURE_SSP";

/// 連番のゴースト数。本番の 1 ページ（src/config/ghost-list.json の pageLimit）を超え、仮想化（80 体以上）と
/// 先読みのページ送りを必ず通る件数にする。1 ページを超えていることは global-setup.ts が照合する。
export const NUMBERED_GHOST_COUNT = 600;

/// 連番以外に置く、検索・文字コードの検証用ゴースト。
export const SPECIAL_GHOSTS = {
  /// ASCII 名。全角で検索して NFKC 正規化を確かめる
  ascii: { dir: "alpha", name: "Alpha Ghost" },
  /// 全角英字の名前。半角で検索して NFKC 正規化を確かめる
  fullWidth: { dir: "fullwidth", name: "Ｆｕｌｌｗｉｄｔｈ Ｇｈｏｓｔ" },
  /// Shift_JIS の descript（charset 指定なし）。名前順では末尾に並ぶ（かなは ASCII より後）
  shiftJis: { dir: "sjis", name: "さくら" },
} as const;

/// 試験用ゴーストの総数（一覧の件数表示の期待値）。
export const FIXTURE_GHOST_TOTAL = NUMBERED_GHOST_COUNT + Object.keys(SPECIAL_GHOSTS).length;

/// 「さくら」を Shift_JIS で表したバイト列（さ=0x82B3・く=0x82AD・ら=0x82E7）。
/// Node は Shift_JIS のエンコーダを持たないため直接書く。
const SAKURA_SHIFT_JIS = Buffer.from([0x82, 0xb3, 0x82, 0xad, 0x82, 0xe7]);

async function writeGhost(ghostRoot: string, dir: string, descript: Buffer): Promise<void> {
  const master = path.join(ghostRoot, dir, "ghost", "master");
  await mkdir(master, { recursive: true });
  await writeFile(path.join(master, "descript.txt"), descript);
}

/// 試験用の SSP フォルダを作る（ssp.exe は存在確認用の空ファイルで、起動はしない）。
/// 戻り値は SSP フォルダのパス。
export async function createFixtureSsp(root: string): Promise<string> {
  const sspPath = path.join(root, "ssp");
  const ghostRoot = path.join(sspPath, "ghost");
  await mkdir(ghostRoot, { recursive: true });
  await writeFile(path.join(sspPath, "ssp.exe"), "");

  for (let i = 1; i <= NUMBERED_GHOST_COUNT; i++) {
    const id = String(i).padStart(4, "0");
    await writeGhost(
      ghostRoot,
      `ghost_${id}`,
      Buffer.from(`charset,UTF-8\nname,Ghost ${id}\ncraftman,Author ${i % 10}\n`, "utf8"),
    );
  }

  const { ascii, fullWidth, shiftJis } = SPECIAL_GHOSTS;
  await writeGhost(ghostRoot, ascii.dir, Buffer.from(`charset,UTF-8\nname,${ascii.name}\n`, "utf8"));
  await writeGhost(ghostRoot, fullWidth.dir, Buffer.from(`charset,UTF-8\nname,${fullWidth.name}\n`, "utf8"));
  await writeGhost(
    ghostRoot,
    shiftJis.dir,
    Buffer.concat([Buffer.from("name,", "ascii"), SAKURA_SHIFT_JIS, Buffer.from("\n", "ascii")]),
  );

  return sspPath;
}

/// globalSetup が作った試験用 SSP のパス。
export function fixtureSspPath(): string {
  const value = process.env[FIXTURE_SSP_ENV];
  if (!value) {
    throw new Error(`${FIXTURE_SSP_ENV} が未設定です（playwright.tauri.config.ts の globalSetup を経由して実行してください）`);
  }
  return value;
}
