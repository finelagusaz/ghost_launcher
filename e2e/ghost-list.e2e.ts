import { test as base, expect } from "@playwright/test";
import { By, until, Key, type WebDriver } from "selenium-webdriver";
import { createHarness, disposeHarness, type Harness } from "./helpers/harness";
import { waitForAppReady, waitForGhosts, openSettings, closeSettings } from "./helpers/ui";

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

/** SSP パス未設定時の空状態テキストを検出する */
async function findEmptyStateText(driver: WebDriver): Promise<string | null> {
  try {
    const el = await driver.findElement(By.css("[data-testid='empty-state']"));
    return el.getText();
  } catch {
    return null;
  }
}

/** 現在 DOM に描画されているゴースト名の一覧を取得する（仮想化の窓内のカードのみ） */
async function visibleGhostNames(driver: WebDriver): Promise<string[]> {
  const els = await driver.findElements(By.css("[data-testid='ghost-name']"));
  return Promise.all(els.map((el) => el.getText()));
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

    // 「設定を開く」ボタンが存在する
    const settingsButton = await driver.findElement(By.css("[data-testid='open-settings-button']"));
    expect(await settingsButton.isDisplayed()).toBe(true);
  }
});

test("設定ダイアログを開閉できる", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  await openSettings(driver);

  // ダイアログタイトル「設定」または "Settings" が表示される（アニメーション完了まで待機）
  const dialogTitleEl = await driver.findElement(
    By.xpath("//h2[text()='設定' or text()='Settings']"),
  );
  await driver.wait(until.elementIsVisible(dialogTitleEl), 5_000);

  await closeSettings(driver);
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

  // 検索ボックスの input 要素を取得
  const searchInput = await driver.findElement(By.css("[data-testid='search-input'] input"));
  // 存在しないゴースト名で検索してフィルタリングを確認
  await searchInput.sendKeys("zzz_nonexistent_ghost_name_zzz");

  // 少し待ってからカード数が減ったことを確認
  await driver.wait(async () => {
    const elements = await driver.findElements(By.css("[data-testid='launch-button']"));
    return elements.length < countBefore || elements.length === 0;
  }, 10_000);

  // 検索をクリアして元に戻ることを確認
  await searchInput.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE);

  await driver.wait(async () => {
    const elements = await driver.findElements(By.css("[data-testid='launch-button']"));
    return elements.length > 0;
  }, 10_000);
});

test("スクロール＆ページネーション: 下にスクロールすると後続のゴーストが表示される", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  // スキャン完了まで待機（SSP未設定またはゴースト0件の場合はスキップ）
  const initialButtons = await waitForGhosts(driver);
  if (!initialButtons) {
    test.skip();
    return;
  }

  // 仮想化は total >= 80 で有効化される（GhostList.tsx の shouldVirtualize）。
  // 仮想化されない件数では全件が同時に描画され、スクロールしても描画内容が
  // 変わらないためスキップする。
  const countText = await driver.findElement(By.css("[aria-live='polite']")).getText();
  const totalMatch = countText.match(/(\d+)/);
  if (!totalMatch || parseInt(totalMatch[1], 10) < 80) {
    test.skip();
    return;
  }

  // 仮想化リストは DOM のカード枚数を一定の窓に保つため「枚数の増加」では検証できない。
  // 代わりに「窓が移動し、スクロール前に無かったゴーストが描画される」ことを検証する。
  const namesBefore = new Set(await visibleGhostNames(driver));

  // ビューポートの末尾までスクロール（scrollTop 代入は scroll イベントを発火する）
  await driver.executeScript(`
    const viewport = document.querySelector("[data-testid='ghost-list-viewport']");
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  `);

  // 末尾行は当初 SkeletonCard（ghost-name を持たない）で、追加読込の完了後に
  // GhostCard へ差し替わる。スクロール前に無かったゴースト名の出現を待機する。
  await driver.wait(async () => {
    const namesNow = await visibleGhostNames(driver);
    return namesNow.some((name) => name.length > 0 && !namesBefore.has(name));
  }, 15_000);

  const namesAfter = await visibleGhostNames(driver);
  expect(namesAfter.some((name) => name.length > 0 && !namesBefore.has(name))).toBe(true);
});
