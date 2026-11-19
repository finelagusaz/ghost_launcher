import { By, Key } from "selenium-webdriver";
import { test, expect } from "./helpers/test";
import { FIXTURE_GHOST_TOTAL, SPECIAL_GHOSTS } from "./helpers/fixture";
import { waitForAppReady, waitForGhosts, openSettings, closeSettings, visibleGhostNames } from "./helpers/ui";

// 既定の開始状態: 試験用 SSP（e2e/helpers/fixture.ts）を設定した日本語の状態

test("起動テスト: アプリが起動しウィンドウが表示される", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  const title = await driver.getTitle();
  expect(title).toBe("Ghost Launcher");
});

test.describe("初回起動（設定ファイルなし）", () => {
  test.use({ settings: null });

  test("SSP パス未設定時に設定誘導が表示される", async ({ harness }) => {
    const { driver } = harness;
    await waitForAppReady(driver);

    // 言語は未設定のため OS の言語で表示される。どちらの言語でも誘導文であること
    const emptyState = await driver.wait(
      async () => (await driver.findElements(By.css("[data-testid='empty-state']")))[0],
      10_000,
      "SSP 未設定の空状態が表示されない",
    );
    const text = await emptyState.getText();
    expect(
      text.includes("SSPフォルダを選択してください") || text.includes("Please select an SSP folder"),
    ).toBe(true);

    const settingsButton = await driver.findElement(By.css("[data-testid='open-settings-button']"));
    expect(await settingsButton.isDisplayed()).toBe(true);
  });
});

test("設定ダイアログを開閉できる", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  await openSettings(driver);

  // （可視になるまでの待機は openSettings が担うため、ここでは存在確認のみでよい）
  await driver.findElement(By.xpath("//h2[text()='設定']"));

  await closeSettings(driver);
});

test("ゴースト一覧: 試験用 SSP の全ゴーストが件数に表れ、カードが表示される", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  const launchButtons = await waitForGhosts(driver);
  expect(launchButtons.length).toBeGreaterThan(0);

  // 件数は先に初期ページの件数が出てから総数へ置き換わるため、総数になるまで待つ
  const countEl = await driver.findElement(By.css("[aria-live='polite']"));
  await driver.wait(
    async () => (await countEl.getText()).includes(String(FIXTURE_GHOST_TOTAL)),
    10_000,
    `件数表示が ${FIXTURE_GHOST_TOTAL} にならない`,
  );
});

test("検索: 一致しない語で空表示になり、クリアで一覧に戻る", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);
  await waitForGhosts(driver);

  const searchInput = await driver.findElement(By.css("[data-testid='search-input'] input"));
  await searchInput.sendKeys("zzz_nonexistent_ghost_name_zzz");

  // 検索 0 件の空表示（クリアボタン付き）に変わり、カードが消える
  await driver.wait(
    async () => {
      const empty = await driver.findElements(By.css("[data-testid='empty-state']"));
      const buttons = await driver.findElements(By.css("[data-testid='launch-button']"));
      return empty.length > 0 && buttons.length === 0;
    },
    10_000,
    "検索 0 件の空表示にならない",
  );

  await searchInput.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE);
  await waitForGhosts(driver, 10_000);
});

test("スクロール＆ページネーション: 末尾までスクロールすると最後のゴーストが読み込まれる", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);
  await waitForGhosts(driver);

  // 試験用 SSP は本番の 1 ページ（500 件）を超えるため、末尾は先読みのページ送りでしか読めない。
  // 名前順の末尾は Shift_JIS の「さくら」（かなは ASCII より後に並ぶ）
  const last = SPECIAL_GHOSTS.shiftJis.name;
  expect(await visibleGhostNames(driver)).not.toContain(last);

  await driver.executeScript(`
    const viewport = document.querySelector("[data-testid='ghost-list-viewport']");
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  `);

  // 末尾行は当初 SkeletonCard（ghost-name を持たない）で、追加読込の完了後に GhostCard へ差し替わる
  await driver.wait(
    async () => (await visibleGhostNames(driver)).includes(last),
    15_000,
    `末尾までスクロールしても「${last}」が表示されない`,
  );
});
