import { By, until, type WebDriver } from "selenium-webdriver";
import { test, expect } from "./helpers/test";
import { SPECIAL_GHOSTS } from "./helpers/fixture";
import { waitForAppReady, waitForGhosts, openSettings, closeSettings, searchAndWait } from "./helpers/ui";

// 既定の開始状態: 試験用 SSP を設定した日本語の状態。テストごとにデータ置き場を作り直すため、
// 言語を英語にしたまま終えても次のテストへ持ち越さない（後片付けは要らない）

/**
 * ダイアログ内の言語セレクトを変更する。
 * Fluent UI Select は native <select> を使うため、JS 経由で change イベントを発火する。
 */
async function setLanguage(driver: WebDriver, lang: "ja" | "en"): Promise<void> {
  const selectEl = await driver.findElement(By.css("[role='dialog'] select"));
  await driver.executeScript(
    `const sel = arguments[0];
     const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
     setter.call(sel, arguments[1]);
     sel.dispatchEvent(new Event('change', { bubbles: true }));`,
    selectEl,
    lang,
  );
}

test("言語切り替え: 英語に切り替えると閉じるボタンが 'Close' になる", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  await openSettings(driver);
  await driver.wait(until.elementLocated(By.xpath("//button[text()='閉じる']")), 5_000);
  await setLanguage(driver, "en");

  const closeEn = await driver.wait(until.elementLocated(By.xpath("//button[text()='Close']")), 5_000);
  expect(await closeEn.isDisplayed()).toBe(true);
});

test("言語切り替え: 英語モードで検索ボックスのプレースホルダが英語になる", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  await openSettings(driver);
  await setLanguage(driver, "en");
  await driver.wait(until.elementLocated(By.xpath("//button[text()='Close']")), 5_000);
  await closeSettings(driver);

  const searchInput = await driver.wait(
    until.elementLocated(By.css("[data-testid='search-input'] input[placeholder='Search by name or author']")),
    5_000,
  );
  expect(await searchInput.isDisplayed()).toBe(true);
});

test("言語切り替え: 日本語に戻すと検索ボックスのプレースホルダが日本語になる", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  await openSettings(driver);
  await setLanguage(driver, "en");
  await driver.wait(until.elementLocated(By.xpath("//button[text()='Close']")), 5_000);
  await setLanguage(driver, "ja");
  await driver.wait(until.elementLocated(By.xpath("//button[text()='閉じる']")), 5_000);
  await closeSettings(driver);

  const searchInput = await driver.wait(
    until.elementLocated(By.css("[data-testid='search-input'] input[placeholder='ゴースト名・作者名で検索']")),
    5_000,
  );
  expect(await searchInput.isDisplayed()).toBe(true);
});

test.describe("初回起動（設定ファイルなし）", () => {
  test.use({ settings: null });

  test("言語切り替え: SSP 未設定時の空状態メッセージも切り替わる", async ({ harness }) => {
    const { driver } = harness;
    await waitForAppReady(driver);

    // 言語は未設定のため OS の言語で始まる。英語へ切り替えた結果を確かめる
    await driver.wait(
      until.elementLocated(
        By.xpath("//*[contains(text(), 'SSPフォルダを選択してください') or contains(text(), 'Please select an SSP folder')]"),
      ),
      10_000,
    );

    // SSP が未設定だと、アプリは起動時に設定ダイアログを自動で開く（useAppShellState）
    const dialog = await driver.wait(until.elementLocated(By.css("[role='dialog']")), 5_000);
    await driver.wait(until.elementIsVisible(dialog), 5_000);
    await setLanguage(driver, "en");
    await driver.wait(until.elementLocated(By.xpath("//button[text()='Close']")), 5_000);
    await closeSettings(driver);

    const emptyMsg = await driver.wait(
      until.elementLocated(By.xpath("//*[contains(text(), 'Please select an SSP folder')]")),
      5_000,
    );
    expect(await emptyMsg.isDisplayed()).toBe(true);

    const openSettingsBtn = await driver.findElement(By.css("[data-testid='open-settings-button']"));
    expect(await openSettingsBtn.isDisplayed()).toBe(true);
  });
});

test("NFKC 正規化: 全角で検索すると半角名のゴーストがヒットする", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);
  await waitForGhosts(driver);

  const { ascii } = SPECIAL_GHOSTS;
  const names = await searchAndWait(driver, "ＡＬＰＨＡ", (found) => found.length === 1 && found[0] === ascii.name);
  expect(names).toEqual([ascii.name]);
});

test("NFKC 正規化: 半角で検索すると全角名のゴーストがヒットする", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);
  await waitForGhosts(driver);

  const { fullWidth } = SPECIAL_GHOSTS;
  const names = await searchAndWait(driver, "fullwidth", (found) => found.length === 1 && found[0] === fullWidth.name);
  expect(names).toEqual([fullWidth.name]);
});

test("文字コード: Shift_JIS の descript から読んだ名前で検索できる", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);
  await waitForGhosts(driver);

  const { shiftJis } = SPECIAL_GHOSTS;
  const names = await searchAndWait(driver, shiftJis.name, (found) => found.length === 1 && found[0] === shiftJis.name);
  expect(names).toEqual([shiftJis.name]);
});
