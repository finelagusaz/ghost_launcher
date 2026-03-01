import { test as base, expect } from "@playwright/test";
import { By, until, type WebDriver } from "selenium-webdriver";
import { createHarness, disposeHarness, type Harness } from "./helpers/harness";

const test = base.extend<{ harness: Harness }>({
  harness: async ({}, use) => {
    const harness = await createHarness();
    try {
      await use(harness);
    } finally {
      await disposeHarness(harness);
    }
  },
});

// --- ヘルパー ---

async function waitForAppReady(driver: WebDriver, timeoutMs = 15_000): Promise<void> {
  // settingsLoading 完了後に描画される h1（Ghost Launcher）が出現するまで待機
  await driver.wait(until.elementLocated(By.css("h1")), timeoutMs);
}

/** 言語に依存しない方法で設定ダイアログを開く */
async function openSettings(driver: WebDriver): Promise<void> {
  try {
    const btn = await driver.findElement(
      By.xpath("//button[contains(., '設定を開く') or contains(., 'Open settings')]"),
    );
    await btn.click();
  } catch {
    // ヘッダーの設定ボタン（テキスト内容で特定）
    const btn = await driver.findElement(
      By.xpath("//button[normalize-space(.)='設定' or normalize-space(.)='Settings']"),
    );
    await btn.click();
  }
  await driver.wait(until.elementLocated(By.css("[role='dialog']")), 5_000);
}

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

/** ダイアログを閉じる（日英どちらかの閉じるボタン） */
async function closeSettings(driver: WebDriver): Promise<void> {
  const closeBtn = await driver.findElement(
    By.xpath("//button[text()='閉じる' or text()='Close']"),
  );
  await closeBtn.click();
  await driver.wait(async () => {
    const dialogs = await driver.findElements(By.css("[role='dialog']"));
    return dialogs.length === 0;
  }, 5_000);
}

// --- テストケース ---

test("言語切り替え: 英語に切り替えると閉じるボタンが 'Close' になる", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  // 既知の状態（日本語）から開始
  await openSettings(driver);
  await setLanguage(driver, "ja");
  await driver.wait(until.elementLocated(By.xpath("//button[text()='閉じる']")), 5_000);
  await closeSettings(driver);

  // 英語に切り替え
  await openSettings(driver);
  await setLanguage(driver, "en");

  // 閉じるボタンが英語になる
  const closeEn = await driver.wait(
    until.elementLocated(By.xpath("//button[text()='Close']")),
    5_000,
  );
  expect(await closeEn.isDisplayed()).toBe(true);
  await closeSettings(driver);

  // 後片付け：日本語に戻す
  await openSettings(driver);
  await setLanguage(driver, "ja");
  await driver.wait(until.elementLocated(By.xpath("//button[text()='閉じる']")), 5_000);
  await closeSettings(driver);
});

test("言語切り替え: 英語モードで検索ボックスのプレースホルダが英語になる", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  // 英語に切り替え
  await openSettings(driver);
  await setLanguage(driver, "en");
  await driver.wait(until.elementLocated(By.xpath("//button[text()='Close']")), 5_000);
  await closeSettings(driver);

  // 検索プレースホルダが英語
  const searchInput = await driver.wait(
    until.elementLocated(By.css("input[placeholder='Search by ghost name']")),
    5_000,
  );
  expect(await searchInput.isDisplayed()).toBe(true);

  // 後片付け：日本語に戻す
  await openSettings(driver);
  await setLanguage(driver, "ja");
  await driver.wait(until.elementLocated(By.xpath("//button[text()='閉じる']")), 5_000);
  await closeSettings(driver);
});

test("言語切り替え: 日本語に戻すと検索ボックスのプレースホルダが日本語になる", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  // 英語にしてから日本語に戻す
  await openSettings(driver);
  await setLanguage(driver, "en");
  await driver.wait(until.elementLocated(By.xpath("//button[text()='Close']")), 5_000);
  await setLanguage(driver, "ja");
  await driver.wait(until.elementLocated(By.xpath("//button[text()='閉じる']")), 5_000);
  await closeSettings(driver);

  // 検索プレースホルダが日本語に戻っている
  const searchInput = await driver.wait(
    until.elementLocated(By.css("input[placeholder='ゴースト名で検索']")),
    5_000,
  );
  expect(await searchInput.isDisplayed()).toBe(true);
});

test("言語切り替え: SSP 未設定時の空状態メッセージも切り替わる", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  // SSP 設定済みならスキップ
  try {
    await driver.findElement(
      By.xpath("//*[contains(text(), 'SSPフォルダを選択してください') or contains(text(), 'Please select an SSP folder')]"),
    );
  } catch {
    test.skip();
    return;
  }

  // 英語に切り替え
  await openSettings(driver);
  await setLanguage(driver, "en");
  await driver.wait(until.elementLocated(By.xpath("//button[text()='Close']")), 5_000);
  await closeSettings(driver);

  // 空状態メッセージが英語になる
  const emptyMsg = await driver.wait(
    until.elementLocated(By.xpath("//*[contains(text(), 'Please select an SSP folder')]")),
    5_000,
  );
  expect(await emptyMsg.isDisplayed()).toBe(true);

  // 「Open settings」ボタンが表示される
  const openSettingsBtn = await driver.findElement(
    By.xpath("//button[contains(., 'Open settings')]"),
  );
  expect(await openSettingsBtn.isDisplayed()).toBe(true);

  // 後片付け：日本語に戻す
  await openSettings(driver);
  await setLanguage(driver, "ja");
  await driver.wait(until.elementLocated(By.xpath("//button[text()='閉じる']")), 5_000);
  await closeSettings(driver);
});

test("NFKC正規化: 全角文字で検索してもゴーストがヒットする", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  // SSP 未設定 or ゴーストが存在しないならスキップ
  try {
    await driver.findElement(
      By.xpath("//*[contains(text(), 'SSPフォルダを選択してください') or contains(text(), 'Please select an SSP folder')]"),
    );
    test.skip();
    return;
  } catch {
    // 空状態でない = ゴーストが存在する可能性あり
  }

  // ゴーストが表示されるまで待機（起動ボタンが出現したら描画済み）
  const launchButtons = await driver.wait(async () => {
    const elements = await driver.findElements(
      By.xpath("//button[normalize-space(.)='起動' or normalize-space(.)='Launch']"),
    );
    return elements.length > 0 ? elements : null;
  }, 15_000);

  if (!launchButtons) {
    test.skip();
    return;
  }

  // 最初のカードのゴースト名を取得（起動ボタンの兄弟 span 先頭から取得）
  let ghostName = "";
  try {
    const firstCardNameEl = await driver.findElement(
      By.xpath("(//button[normalize-space(.)='起動' or normalize-space(.)='Launch'])[1]/parent::div/div[1]/span[1]"),
    );
    ghostName = await firstCardNameEl.getText();
  } catch {
    test.skip();
    return;
  }
  if (!ghostName || ghostName.length === 0) {
    test.skip();
    return;
  }

  // ゴースト名の最初の文字を全角に変換して検索
  const firstChar = ghostName[0];
  const fullWidthChar = String.fromCodePoint((firstChar.codePointAt(0) ?? 0) + 0xFEE0);
  // ASCII 範囲（0x21-0x7E）のみ変換、それ以外はそのまま使う
  const searchQuery = firstChar.codePointAt(0) !== undefined &&
    firstChar.codePointAt(0)! >= 0x21 &&
    firstChar.codePointAt(0)! <= 0x7E
    ? fullWidthChar
    : firstChar;

  const searchInput = await driver.findElement(
    By.css("input[placeholder='ゴースト名で検索'], input[placeholder='Search by ghost name']"),
  );
  await searchInput.sendKeys(searchQuery);

  // NFKC 正規化により結果が 1 件以上ヒットする
  await driver.wait(async () => {
    const elements = await driver.findElements(
      By.xpath("//button[normalize-space(.)='起動' or normalize-space(.)='Launch']"),
    );
    return elements.length > 0;
  }, 10_000);

  const results = await driver.findElements(
    By.xpath("//button[normalize-space(.)='起動' or normalize-space(.)='Launch']"),
  );
  expect(results.length).toBeGreaterThan(0);
});
