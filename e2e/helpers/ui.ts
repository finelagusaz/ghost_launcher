import { By, until, error as seleniumError, type WebDriver, type WebElement } from "selenium-webdriver";

/** アプリの初期ロードを待機する（ルート要素が描画されるまで） */
export async function waitForAppReady(driver: WebDriver, timeoutMs = 15_000): Promise<void> {
  // settingsLoading 完了後に描画される h1（Ghost Launcher）が出現するまで待機
  await driver.wait(until.elementLocated(By.css("h1")), timeoutMs);
}

/**
 * スキャン完了（ゴーストカードの表示）まで待機し、起動ボタン一覧を返す。
 * E2E は試験用 SSP を使うためゴーストは必ず存在する。現れなければ skip せず失敗させる
 * （環境次第で黙って skip されると、検証していないのに通ったように見える）。
 * 初回起動は全件スキャンを伴うため、待ち時間を長めに取る。
 */
export async function waitForGhosts(driver: WebDriver, timeoutMs = 30_000): Promise<WebElement[]> {
  let found: WebElement[] = [];
  await driver.wait(async () => {
    found = await driver.findElements(By.css("[data-testid='launch-button']"));
    return found.length > 0;
  }, timeoutMs, "ゴーストカードが表示されない（試験用 SSP のスキャンが終わらない）");
  return found;
}

/** 一覧に表示中のゴースト名（仮想化の窓内のカードのみ）。差し替え中で stale な要素は空文字にする */
export async function visibleGhostNames(driver: WebDriver): Promise<string[]> {
  const els = await driver.findElements(By.css("[data-testid='ghost-name']"));
  return Promise.all(
    els.map(async (el) => {
      try {
        return await el.getText();
      } catch (err) {
        // 仮想リストの再描画（SkeletonCard → GhostCard 差し替え）で要素が差し替わると
        // getText が stale になる。呼び出し側の wait が次周期で再取得するため空文字として扱う
        if (err instanceof seleniumError.StaleElementReferenceError) {
          return "";
        }
        throw err;
      }
    }),
  );
}

/** 検索欄に入力し、表示中のゴースト名が条件を満たすまで待ってから返す */
export async function searchAndWait(
  driver: WebDriver,
  query: string,
  until: (names: string[]) => boolean,
  timeoutMs = 10_000,
): Promise<string[]> {
  const input = await driver.findElement(By.css("[data-testid='search-input'] input"));
  await input.sendKeys(query);
  let names: string[] = [];
  try {
    await driver.wait(async () => {
      names = (await visibleGhostNames(driver)).filter((name) => name.length > 0);
      return until(names);
    }, timeoutMs);
  } catch (err) {
    throw new Error(`検索「${query}」の結果が期待どおりにならない（最後に見えた名前: ${JSON.stringify(names)}）`, { cause: err });
  }
  return names;
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
  // 存在だけでなく可視になるまで待つ。Fluent UI Dialog は <dialog> 要素を使い、
  // open 属性が付くまで子孫ごと display:none になるため、elementLocated だけでは
  // 開くアニメーションの途中を掴み「存在するが不可視」の要素を呼び出し側へ渡してしまう。
  const dialog = await driver.wait(until.elementLocated(By.css("[role='dialog']")), 5_000);
  await driver.wait(until.elementIsVisible(dialog), 5_000);
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
