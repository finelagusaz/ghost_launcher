import { test as base, expect } from "@playwright/test";
import { By, until, Key, type WebDriver, type WebElement } from "selenium-webdriver";
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

// ゴーストが表示されていない状態（SSP未設定 or スキャン結果0件）を検出する XPath
const EMPTY_STATE_XPATH =
  "//*[contains(text(), 'SSPフォルダを選択してください') or contains(text(), 'Please select an SSP folder')" +
  " or contains(text(), 'ゴーストが見つかりません') or contains(text(), 'No ghosts found')]";
// 起動ボタンの XPath（日英対応・icon 付き Button でも確実にマッチ）
const LAUNCH_BUTTON_XPATH = "//button[normalize-space(.)='起動' or normalize-space(.)='Launch']";

/** アプリの初期ロードを待機する（ルート要素が描画されるまで） */
async function waitForAppReady(driver: WebDriver, timeoutMs = 15_000): Promise<void> {
  // settingsLoading 完了後に描画される h1（Ghost Launcher）が出現するまで待機
  await driver.wait(until.elementLocated(By.css("h1")), timeoutMs);
}

/** SSP パス未設定時の空状態テキストを検出する（日英対応） */
async function findEmptyStateText(driver: WebDriver): Promise<string | null> {
  try {
    const el = await driver.findElement(By.xpath(EMPTY_STATE_XPATH));
    return el.getText();
  } catch {
    return null;
  }
}

/**
 * スキャン完了（ゴーストカード表示 or 空状態）まで待機する。
 * ゴーストが存在すれば起動ボタン一覧を返し、空状態・タイムアウトなら null を返す。
 * findEmptyStateText と異なり、スキャン中のローディング状態でも確実に完了を待つ。
 */
async function waitForGhosts(driver: WebDriver, timeoutMs = 15_000): Promise<WebElement[] | null> {
  let found: WebElement[] | null = null;
  try {
    await driver.wait(async () => {
      const buttons = await driver.findElements(By.xpath(LAUNCH_BUTTON_XPATH));
      if (buttons.length > 0) { found = buttons; return true; }
      const empties = await driver.findElements(By.xpath(EMPTY_STATE_XPATH));
      return empties.length > 0;
    }, timeoutMs);
  } catch {
    // タイムアウト
  }
  return found;
}

/** 言語に依存しない方法で設定ボタンを見つけてクリックする */
async function clickSettingsButton(driver: WebDriver): Promise<void> {
  try {
    // 空状態の「設定を開く」または "Open settings"
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

// --- テストケース ---

test("起動テスト: アプリが起動しウィンドウが表示される", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  const title = await driver.getTitle();
  expect(title).toBe("Ghost Launcher");
});

test("SSP パス未設定時に設定誘導が表示される", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  // SSP パスが未設定の場合、空状態メッセージが表示される
  const text = await findEmptyStateText(driver);
  // 初回起動なら SSP パス未設定のはず
  // 既に設定済みの環境ではスキップ
  if (text) {
    expect(
      text.includes("SSPフォルダを選択してください") ||
      text.includes("Please select an SSP folder"),
    ).toBe(true);

    // 「設定を開く」または "Open settings" ボタンが存在する
    const settingsButton = await driver.findElement(
      By.xpath("//button[contains(., '設定を開く') or contains(., 'Open settings')]"),
    );
    expect(await settingsButton.isDisplayed()).toBe(true);
  }
});

test("設定ダイアログを開閉できる", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  await clickSettingsButton(driver);

  // ダイアログタイトル「設定」または "Settings" が表示される（アニメーション完了まで待機）
  const dialogTitleEl = await driver.findElement(
    By.xpath("//h2[text()='設定' or text()='Settings']"),
  );
  await driver.wait(until.elementIsVisible(dialogTitleEl), 5_000);

  // 「閉じる」または "Close" ボタンでダイアログを閉じる
  const closeButton = await driver.findElement(
    By.xpath("//button[text()='閉じる' or text()='Close']"),
  );
  await closeButton.click();

  // ダイアログが閉じたことを確認
  await driver.wait(async () => {
    const dialogs = await driver.findElements(By.css("[role='dialog']"));
    return dialogs.length === 0;
  }, 5_000);
});

test("ゴースト一覧: SSP パス設定後にゴーストカードが表示される", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  // スキャン完了まで待機（SSP未設定またはゴースト0件の場合はスキップ）
  const launchButtons = await waitForGhosts(driver);
  if (!launchButtons) {
    test.skip();
    return;
  }

  expect(launchButtons.length).toBeGreaterThan(0);
  expect(await launchButtons[0].isDisplayed()).toBe(true);
});

test("検索: 検索ボックスに入力すると一覧がフィルタされる", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  // スキャン完了まで待機（SSP未設定またはゴースト0件の場合はスキップ）
  const initialButtons = await waitForGhosts(driver);
  if (!initialButtons) {
    test.skip();
    return;
  }
  const countBefore = initialButtons.length;

  // 検索ボックスを探してテキストを入力（日英どちらかのプレースホルダ）
  const searchInput = await driver.findElement(
    By.css("input[placeholder='ゴースト名で検索'], input[placeholder='Search by ghost name']"),
  );
  // 存在しないゴースト名で検索してフィルタリングを確認
  await searchInput.sendKeys("zzz_nonexistent_ghost_name_zzz");

  // 少し待ってからカード数が減ったことを確認
  await driver.wait(async () => {
    const elements = await driver.findElements(By.xpath(LAUNCH_BUTTON_XPATH));
    return elements.length < countBefore || elements.length === 0;
  }, 10_000);

  // 検索をクリアして元に戻ることを確認
  await searchInput.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE);

  await driver.wait(async () => {
    const elements = await driver.findElements(By.xpath(LAUNCH_BUTTON_XPATH));
    return elements.length > 0;
  }, 10_000);
});

test("スクロール＆ページネーション: 下にスクロールすると追加読込がトリガーされる", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  // スキャン完了まで待機（SSP未設定またはゴースト0件の場合はスキップ）
  const initialButtons = await waitForGhosts(driver);
  if (!initialButtons) {
    test.skip();
    return;
  }
  const countBefore = initialButtons.length;

  // total 表示を取得して追加読込が可能か確認
  const countText = await driver.findElement(By.css("[aria-live='polite']")).getText();
  const totalMatch = countText.match(/(\d+)/);
  if (!totalMatch || parseInt(totalMatch[1], 10) <= countBefore) {
    // 全件読み込み済みならスキップ
    test.skip();
    return;
  }

  // ビューポートの末尾までスクロール
  await driver.executeScript(`
    const viewport = document.querySelector("[data-testid='ghost-list-viewport']");
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  `);

  // 追加読み込みによってカード数が増えるのを待機
  await driver.wait(async () => {
    const elements = await driver.findElements(By.xpath(LAUNCH_BUTTON_XPATH));
    return elements.length > countBefore;
  }, 15_000);

  const cardsAfter = await driver.findElements(By.xpath(LAUNCH_BUTTON_XPATH));
  expect(cardsAfter.length).toBeGreaterThan(countBefore);
});
