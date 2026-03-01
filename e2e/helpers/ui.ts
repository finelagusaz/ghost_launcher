import { By, until, type WebDriver, type WebElement } from "selenium-webdriver";

/** アプリの初期ロードを待機する（ルート要素が描画されるまで） */
export async function waitForAppReady(driver: WebDriver, timeoutMs = 15_000): Promise<void> {
  // settingsLoading 完了後に描画される h1（Ghost Launcher）が出現するまで待機
  await driver.wait(until.elementLocated(By.css("h1")), timeoutMs);
}

/**
 * スキャン完了（ゴーストカード表示 or 空状態）まで待機する。
 * ゴーストが存在すれば起動ボタン一覧を返し、空状態・タイムアウトなら null を返す。
 * スキャン中のローディング状態でも確実に完了を待つ。
 */
export async function waitForGhosts(driver: WebDriver, timeoutMs = 15_000): Promise<WebElement[] | null> {
  let found: WebElement[] | null = null;
  try {
    await driver.wait(async () => {
      const buttons = await driver.findElements(By.css("[data-testid='launch-button']"));
      if (buttons.length > 0) { found = buttons; return true; }
      const empties = await driver.findElements(By.css("[data-testid='empty-state']"));
      return empties.length > 0;
    }, timeoutMs);
  } catch {
    // タイムアウト
  }
  return found;
}

/** 設定ダイアログを開く（空状態ボタンとヘッダーボタンの両方に対応） */
export async function openSettings(driver: WebDriver): Promise<void> {
  try {
    // 空状態の「設定を開く」ボタン
    const btn = await driver.findElement(By.css("[data-testid='open-settings-button']"));
    await btn.click();
  } catch {
    // ヘッダーの設定ボタン
    const btn = await driver.findElement(By.css("[data-testid='settings-button']"));
    await btn.click();
  }
  await driver.wait(until.elementLocated(By.css("[role='dialog']")), 5_000);
}

/** 設定ダイアログを閉じる */
export async function closeSettings(driver: WebDriver): Promise<void> {
  const closeBtn = await driver.findElement(By.css("[data-testid='settings-close-button']"));
  await closeBtn.click();
  await driver.wait(async () => {
    const dialogs = await driver.findElements(By.css("[role='dialog']"));
    return dialogs.length === 0;
  }, 5_000);
}
