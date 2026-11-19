import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";

/// 試験用 SSP の場所を、globalSetup からテストへ渡す環境変数。
export const FIXTURE_SSP_ENV = "GHOST_LAUNCHER_E2E_FIXTURE_SSP";

/// 連番のゴースト数。本番の 1 ページ（src/App.tsx の LIMIT）を超え、仮想化（80 体以上）と
/// 先読みのページ送りを必ず通る件数にする。LIMIT を超えていることは global-setup.ts が照合する。
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

/// サムネイルの表示を確かめるゴースト。名前と場所は、既存の検索の試験（alpha・fullwidth・さくら）に
/// 引っかからず、名前順の末尾（さくら）も崩さないものにする。
export const THUMBNAIL_GHOSTS = {
  /// ゴースト直下の thumbnail.png（アルファあり）。<img> で描かれる
  selfAlpha: { dir: "thumb_png", name: "Thumb Png" },
  /// shell/master/surface0.png（アルファなし）。左上の色をキーカラーとして canvas で抜く
  keyColor: { dir: "thumb_key", name: "Thumb Keycolor" },
  /// SSP の外の実体を junction で指すゴースト（thumbnail.png、アルファあり）
  linked: { dir: "thumb_linked", name: "Thumb Linked" },
  /// フォルダ名に日本語と URL で意味を持つ記号を含むゴースト（thumbnail.png、アルファあり）。
  /// パスが encodeURIComponent → WebView2 → Rust の decode を往復して元に戻ることを確かめる
  symbols: { dir: "サムネ 記号 #%+&=;", name: "Thumb Symbols" },
} as const;

/// 試験用ゴーストの総数（一覧の件数表示の期待値）。
export const FIXTURE_GHOST_TOTAL =
  NUMBERED_GHOST_COUNT + Object.keys(SPECIAL_GHOSTS).length + Object.keys(THUMBNAIL_GHOSTS).length;

/// キーカラー画像の左上（抜かれる色）と、それ以外の色。
export const KEY_COLOR = [255, 0, 0] as const;
const BODY_COLOR = [0, 0, 255] as const;

/// 最小の PNG を作る（8bit。alpha=true で RGBA、false で RGB）。左上 1 画素だけ KEY_COLOR にする。
function makePng(size: number, alpha: boolean): Buffer {
  const channels = alpha ? 4 : 3;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * channels); // 先頭はフィルタ種別 0
    for (let x = 0; x < size; x++) {
      const [r, g, b] = x === 0 && y === 0 ? KEY_COLOR : BODY_COLOR;
      row.set(alpha ? [r, g, b, 255] : [r, g, b], 1 + x * channels);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, alpha ? 6 : 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/// ゴースト構造の外に置いた PNG。サムネイルとして読めてはならない。
export function fixtureOutsidePngPath(sspPath: string): string {
  return path.join(path.dirname(sspPath), "outside", "not_a_thumbnail.png");
}

/// junction ゴーストの実体（SSP の外）。
function linkedGhostTarget(sspPath: string): string {
  return path.join(path.dirname(sspPath), "outside", "linked_ghost");
}

/// サムネイルを持つゴーストのサムネイルのパス（アプリが DB に記録する値と同じ形）。
export function fixtureThumbnailPath(sspPath: string, ghost: keyof typeof THUMBNAIL_GHOSTS): string {
  const ghostDir = path.join(sspPath, "ghost", THUMBNAIL_GHOSTS[ghost].dir);
  return ghost === "keyColor"
    ? path.join(ghostDir, "shell", "master", "surface0.png")
    : path.join(ghostDir, "thumbnail.png");
}

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

  const { selfAlpha, keyColor, linked, symbols } = THUMBNAIL_GHOSTS;
  const descript = (name: string) => Buffer.from(`charset,UTF-8\nname,${name}\n`, "utf8");
  await writeGhost(ghostRoot, selfAlpha.dir, descript(selfAlpha.name));
  await writeFile(fixtureThumbnailPath(sspPath, "selfAlpha"), makePng(16, true));
  await writeGhost(ghostRoot, symbols.dir, descript(symbols.name));
  await writeFile(fixtureThumbnailPath(sspPath, "symbols"), makePng(16, true));
  await writeGhost(ghostRoot, keyColor.dir, descript(keyColor.name));
  const keyShell = path.dirname(fixtureThumbnailPath(sspPath, "keyColor"));
  await mkdir(keyShell, { recursive: true });
  await writeFile(fixtureThumbnailPath(sspPath, "keyColor"), makePng(16, false));

  // junction の実体は SSP の外に置く。junction は特権なしで作れる
  const target = linkedGhostTarget(sspPath);
  await writeGhost(path.dirname(target), path.basename(target), descript(linked.name));
  await writeFile(path.join(target, "thumbnail.png"), makePng(16, true));
  await symlink(target, path.join(ghostRoot, linked.dir), "junction");

  await writeFile(fixtureOutsidePngPath(sspPath), makePng(16, true));

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
