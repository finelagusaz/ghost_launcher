import { test as base, expect } from "@playwright/test";
import { By, until, Key, type WebDriver } from "selenium-webdriver";
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

/** アプリの初期ロードを待機する（ルート要素が描画されるまで） */
async function waitForAppReady(driver: WebDriver, timeoutMs = 15_000): Promise<void> {
  // settingsLoading 完了後に描画される h1（Ghost Launcher）が出現するまで待機
  await driver.wait(until.elementLocated(By.css("h1")), timeoutMs);
}

/** SSP パス未設定時の空状態テキストを検出する（日英対応） */
async function findEmptyStateText(driver: WebDriver): Promise<string | null> {
  try {
    const el = await driver.findElement(
      By.xpath("//*[contains(text(), 'SSPフォルダを選択してください') or contains(text(), 'Please select an SSP folder')]"),
    );
    return el.getText();
  } catch {
    return null;
  }
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

  // ゴーストカードの存在を確認（SSP パスが設定済みの環境が前提）
  // 未設定の場合は空状態が表示されるのでスキップ
  const emptyState = await findEmptyStateText(driver);
  if (emptyState) {
    test.skip();
    return;
  }

  // 起動ボタン（日英）が 1 つ以上表示される = ゴーストカードが描画されている
  const launchButtons = await driver.wait(async () => {
    const elements = await driver.findElements(
      By.xpath("//button[normalize-space(.)='起動' or normalize-space(.)='Launch']"),
    );
    return elements.length > 0 ? elements : null;
  }, 15_000);

  expect(launchButtons).not.toBeNull();
  expect(launchButtons!.length).toBeGreaterThan(0);
  expect(await launchButtons![0].isDisplayed()).toBe(true);
});

test("検索: 検索ボックスに入力すると一覧がフィルタされる", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  // SSP パス未設定ならスキップ
  const emptyState = await findEmptyStateText(driver);
  if (emptyState) {
    test.skip();
    return;
  }

  // ゴーストが読み込まれるまで待機
  await driver.wait(async () => {
    const elements = await driver.findElements(
      By.xpath("//button[normalize-space(.)='起動' or normalize-space(.)='Launch']"),
    );
    return elements.length > 0;
  }, 15_000);

  // 検索前の起動ボタン数（= カード数）を取得
  const cardsBefore = await driver.findElements(
    By.xpath("//button[normalize-space(.)='起動' or normalize-space(.)='Launch']"),
  );
  const countBefore = cardsBefore.length;

  // 検索ボックスを探してテキストを入力（日英どちらかのプレースホルダ）
  const searchInput = await driver.findElement(
    By.css("input[placeholder='ゴースト名で検索'], input[placeholder='Search by ghost name']"),
  );
  // 存在しないゴースト名で検索してフィルタリングを確認
  await searchInput.sendKeys("zzz_nonexistent_ghost_name_zzz");

  // 少し待ってからカード数が減ったことを確認
  await driver.wait(async () => {
    const elements = await driver.findElements(
      By.xpath("//button[normalize-space(.)='起動' or normalize-space(.)='Launch']"),
    );
    return elements.length < countBefore || elements.length === 0;
  }, 10_000);

  // 検索をクリアして元に戻ることを確認
  await searchInput.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE);

  await driver.wait(async () => {
    const elements = await driver.findElements(
      By.xpath("//button[normalize-space(.)='起動' or normalize-space(.)='Launch']"),
    );
    return elements.length > 0;
  }, 10_000);
});

test("スクロール＆ページネーション: 下にスクロールすると追加読込がトリガーされる", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  // SSP パス未設定ならスキップ
  const emptyState = await findEmptyStateText(driver);
  if (emptyState) {
    test.skip();
    return;
  }

  // ゴーストが読み込まれるまで待機
  await driver.wait(async () => {
    const elements = await driver.findElements(
      By.xpath("//button[normalize-space(.)='起動' or normalize-space(.)='Launch']"),
    );
    return elements.length > 0;
  }, 15_000);

  // 初回読込の起動ボタン数（= カード数）を取得
  const cardsBefore = await driver.findElements(
    By.xpath("//button[normalize-space(.)='起動' or normalize-space(.)='Launch']"),
  );
  const countBefore = cardsBefore.length;

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
    const elements = await driver.findElements(
      By.xpath("//button[normalize-space(.)='起動' or normalize-space(.)='Launch']"),
    );
    return elements.length > countBefore;
  }, 15_000);

  const cardsAfter = await driver.findElements(
    By.xpath("//button[normalize-space(.)='起動' or normalize-space(.)='Launch']"),
  );
  expect(cardsAfter.length).toBeGreaterThan(countBefore);
});
