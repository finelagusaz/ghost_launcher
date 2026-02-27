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
  // Fluent UI のシェルが描画されるまで待機
  await driver.wait(until.elementLocated(By.css("[class*='shell']")), timeoutMs);
}

/** SSP パス未設定時の空状態テキストを検出する */
async function findEmptyStateText(driver: WebDriver): Promise<string | null> {
  try {
    const el = await driver.findElement(By.xpath("//*[contains(text(), 'SSPフォルダを選択してください')]"));
    return el.getText();
  } catch {
    return null;
  }
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
    expect(text).toContain("SSPフォルダを選択してください");

    // 「設定を開く」ボタンが存在する
    const settingsButton = await driver.findElement(
      By.xpath("//button[contains(., '設定を開く')]"),
    );
    expect(await settingsButton.isDisplayed()).toBe(true);
  }
});

test("設定ダイアログを開閉できる", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  // ヘッダーの設定ボタン、または空状態の「設定を開く」ボタンをクリック
  let settingsButton: Awaited<ReturnType<WebDriver["findElement"]>>;
  try {
    settingsButton = await driver.findElement(
      By.xpath("//button[contains(., '設定を開く')]"),
    );
  } catch {
    // ヘッダーの設定アイコンボタン（aria-label="設定"）
    settingsButton = await driver.findElement(
      By.css("button[aria-label='設定']"),
    );
  }
  await settingsButton.click();

  // ダイアログタイトル「設定」が表示される
  const dialogTitle = await driver.wait(
    until.elementLocated(By.xpath("//*[contains(@class, 'fui-DialogTitle') or @role='dialog']//h2[text()='設定'] | //h2[text()='設定']")),
    5_000,
  );
  expect(await dialogTitle.isDisplayed()).toBe(true);

  // 「閉じる」ボタンでダイアログを閉じる
  const closeButton = await driver.findElement(
    By.xpath("//button[contains(., '閉じる')]"),
  );
  await closeButton.click();

  // ダイアログが閉じたことを確認（タイトルが非表示になる）
  await driver.wait(async () => {
    try {
      const el = await driver.findElement(By.xpath("//h2[text()='設定']"));
      return !(await el.isDisplayed());
    } catch {
      // 要素が見つからない = 閉じた
      return true;
    }
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

  // カード要素が 1 つ以上存在する
  const cards = await driver.wait(async () => {
    const elements = await driver.findElements(By.css("[class*='card']"));
    return elements.length > 0 ? elements : null;
  }, 15_000);

  expect(cards).not.toBeNull();
  expect(cards!.length).toBeGreaterThan(0);

  // 最初のカードに「起動」ボタンがある
  const launchButton = await cards![0].findElement(
    By.xpath(".//button[contains(., '起動')]"),
  );
  expect(await launchButton.isDisplayed()).toBe(true);
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
    const elements = await driver.findElements(By.css("[class*='card']"));
    return elements.length > 0;
  }, 15_000);

  // 検索前のカード数を取得
  const cardsBefore = await driver.findElements(By.css("[class*='card']"));
  const countBefore = cardsBefore.length;

  // 検索ボックスを探してテキストを入力
  const searchInput = await driver.findElement(
    By.css("input[placeholder='ゴースト名で検索']"),
  );
  // 存在しないゴースト名で検索してフィルタリングを確認
  await searchInput.sendKeys("zzz_nonexistent_ghost_name_zzz");

  // 少し待ってからカード数が減ったことを確認
  await driver.wait(async () => {
    const elements = await driver.findElements(By.css("[class*='card']"));
    return elements.length < countBefore || elements.length === 0;
  }, 10_000);

  // 検索をクリアして元に戻ることを確認
  await searchInput.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE);

  await driver.wait(async () => {
    const elements = await driver.findElements(By.css("[class*='card']"));
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
    const elements = await driver.findElements(By.css("[class*='card']"));
    return elements.length > 0;
  }, 15_000);

  // 初回読込のカード数を取得
  const cardsBefore = await driver.findElements(By.css("[class*='card']"));
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
    const viewport = document.querySelector("[class*='viewport']");
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  `);

  // 追加読み込みによってカード数が増えるのを待機
  await driver.wait(async () => {
    const elements = await driver.findElements(By.css("[class*='card']"));
    return elements.length > countBefore;
  }, 15_000);

  const cardsAfter = await driver.findElements(By.css("[class*='card']"));
  expect(cardsAfter.length).toBeGreaterThan(countBefore);
});
