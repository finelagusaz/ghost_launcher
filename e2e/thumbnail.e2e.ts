import { By, type WebDriver, type WebElement } from "selenium-webdriver";
import { test, expect } from "./helpers/test";
import { THUMBNAIL_GHOSTS, fixtureOutsidePngPath, fixtureSspPath } from "./helpers/fixture";
import { waitForAppReady, waitForGhosts, searchAndWait } from "./helpers/ui";

// サムネイルは専用の読み取りプロトコルで webview へ渡す。ゴーストのサムネイルとして成り立つ形の
// パスだけを返し、それ以外のファイルは読ませない。既定の開始状態: 試験用 SSP を設定した日本語の状態

/// アプリがサムネイルに使うプロトコル名（src/lib/thumbnailUrl.ts と同じ値）。
const THUMBNAIL_SCHEME = "thumbnail";

/// ゴーストを名前で検索し、カードにマウスを載せて、サムネイル表示の中身（img か canvas）を返す。
async function hoverThumbnail(driver: WebDriver, name: string): Promise<WebElement> {
  await waitForGhosts(driver);
  await searchAndWait(driver, name, (found) => found.length === 1 && found[0] === name);
  const card = await driver.findElement(By.css("[data-testid='ghost-name']"));
  await driver.actions().move({ origin: card }).perform();
  return driver.wait(async () => {
    const found = await driver.findElements(By.css("[data-testid='thumbnail-overlay'] img, [data-testid='thumbnail-overlay'] canvas"));
    return found[0] ?? null;
  }, 5_000, `${name} のサムネイル表示が出ない`);
}

/// img の読み込みが終わるまで待ち、画像の幅を返す（読み込みに失敗したら 0）。
async function loadedImageWidth(driver: WebDriver, img: WebElement): Promise<number> {
  return driver.executeAsyncScript(
    `const [img, done] = arguments;
     const finish = () => done(img.naturalWidth);
     if (img.complete) finish(); else { img.onload = finish; img.onerror = () => done(0); }`,
    img,
  );
}

// アルファありの画像は <img> で描かれる。置き場所とパスの違うゴーストで、読み込めることを確かめる
const IMG_CASES = [
  { ghost: THUMBNAIL_GHOSTS.selfAlpha, title: "ゴースト直下の thumbnail.png" },
  { ghost: THUMBNAIL_GHOSTS.linked, title: "SSP の外を junction で指すゴースト" },
  { ghost: THUMBNAIL_GHOSTS.symbols, title: "フォルダ名に日本語と記号を含むゴースト" },
] as const;

for (const { ghost, title } of IMG_CASES) {
  test(`サムネイル: ${title}のサムネイル（アルファあり）が表示される`, async ({ harness }) => {
    const { driver } = harness;
    await waitForAppReady(driver);
    const el = await hoverThumbnail(driver, ghost.name);
    expect(await el.getTagName()).toBe("img");
    expect(await loadedImageWidth(driver, el)).toBeGreaterThan(0);
  });
}

test("サムネイル: surface0.png（アルファなし）はキーカラーを抜いて canvas に描かれる", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);
  const el = await hoverThumbnail(driver, THUMBNAIL_GHOSTS.keyColor.name);
  expect(await el.getTagName()).toBe("canvas");

  // 画像の読み込み（crossOrigin=anonymous）が通り、左上の色だけが透明になっていること。
  // 応答に CORS の許可が無いと読み込み自体が失敗し、canvas は大きさを持たない
  const alphas = await driver.wait(async () => {
    return driver.executeScript<number[] | null>(
      `const c = arguments[0];
       if (c.width === 0) return null;
       const d = c.getContext("2d").getImageData(0, 0, 2, 1).data;
       return [d[3], d[7]];`,
      el,
    );
  }, 5_000, "キーカラーの canvas が描かれない");
  expect(alphas).toEqual([0, 255]);
});

test("サムネイル: ゴースト構造の外の画像は webview から読めない", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  // 乗っ取られた JS の立場で、サムネイル用のプロトコルに任意のパスを渡して読ませようとする
  const loaded = await driver.executeAsyncScript<boolean>(
    `const [path, scheme, done] = arguments;
     const img = new Image();
     img.onload = () => done(img.naturalWidth > 0);
     img.onerror = () => done(false);
     img.src = window.__TAURI_INTERNALS__.convertFileSrc(path, scheme);`,
    fixtureOutsidePngPath(fixtureSspPath()),
    THUMBNAIL_SCHEME,
  );
  expect(loaded).toBe(false);
});
