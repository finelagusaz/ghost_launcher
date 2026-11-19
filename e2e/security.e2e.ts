import type { WebDriver } from "selenium-webdriver";
import { test, expect } from "./helpers/test";
import { fixtureSspPath } from "./helpers/fixture";
import { waitForAppReady, waitForGhosts } from "./helpers/ui";

// webview に渡した権限が設計どおり狭いことを、実際に拒否されることで確かめる。
// 既定の開始状態: 試験用 SSP を設定した日本語の状態

/// アプリが ghosts.db を開く接続文字列（src/lib/ghostDatabase.ts の loadDb と同じ値）。
const APP_DB = "sqlite:ghosts.db?mode=ro";

type InvokeResult = { ok: true; value: unknown } | { ok: false; error: unknown };

/// webview の中から Tauri のコマンドを直接呼ぶ（画面の操作を経ない、乗っ取られた JS の立場）。
/// エラーは文字列化せずそのまま返す（プラグインは文字列、アプリのコマンドは種別つきの
/// オブジェクト `CommandError` で reject する）。
async function invokeFromWebview(driver: WebDriver, cmd: string, args: Record<string, unknown>): Promise<InvokeResult> {
  return driver.executeScript(
    `return window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(
       (value) => ({ ok: true, value }),
       (error) => ({ ok: false, error }),
     );`,
    cmd,
    args,
  );
}

test("SQL: JS からの読み取りは通るが、書き込みは権限と読み取り専用の接続の両方で拒否される", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);
  await waitForGhosts(driver);

  // 対照: 同じ経路で読み取りは通る（以下の拒否が、呼び出し経路の不備によるものでないことの確認）
  const read = await invokeFromWebview(driver, "plugin:sql|select", {
    db: APP_DB,
    query: "SELECT COUNT(*) AS n FROM ghosts",
    values: [],
  });
  expect(read).toMatchObject({ ok: true });

  // execute コマンドは権限で拒否される
  const execute = await invokeFromWebview(driver, "plugin:sql|execute", {
    db: APP_DB,
    query: "DELETE FROM ghosts",
    values: [],
  });
  expect(execute.ok).toBe(false);
  expect(execute.ok ? "" : String(execute.error)).toMatch(/not allowed/i);

  // select は任意の文を流せるため、書き込みは接続が読み取り専用であることで止める
  const writeViaSelect = await invokeFromWebview(driver, "plugin:sql|select", {
    db: APP_DB,
    query: "DELETE FROM ghosts",
    values: [],
  });
  expect(writeViaSelect.ok).toBe(false);
  expect(writeViaSelect.ok ? "" : String(writeViaSelect.error)).toMatch(/readonly|read-only/i);
});

test("SQL: JS は別の接続を開けない（書き込み可能な接続・任意の場所のファイルを作れない）", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);
  await waitForGhosts(driver);

  // load が通ると、起動履歴の user-data.db を書き込み可能で開けるうえ、"sqlite:" 以降は
  // データ置き場への push なので、絶対パスで任意の場所に SQLite ファイルを作れる
  for (const db of ["sqlite:user-data.db", "sqlite:ghosts.db"]) {
    const load = await invokeFromWebview(driver, "plugin:sql|load", { db });
    expect(load.ok, db).toBe(false);
    expect(load.ok ? "" : String(load.error), db).toMatch(/not allowed/i);
  }
});

test("CSP: 後から差し込んだインラインスクリプトは実行されない", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  // WebDriver のスクリプト実行自体は CSP を受けないので、そこから DOM へ <script> を差し込み、
  // ページの CSP の下でインラインスクリプトとして評価させる。
  // Tauri は自前の初期化スクリプトのハッシュを script-src に足すため、script-src に
  // 'unsafe-inline' を書いても無視される（この試験はそれを区別しない）。CSP を外した
  // ビルド（csp: null）では落ちることを確かめてある
  const ran = await driver.executeScript(`
    window.__inlineScriptRan = false;
    const script = document.createElement("script");
    script.textContent = "window.__inlineScriptRan = true;";
    document.head.appendChild(script);
    return window.__inlineScriptRan;
  `);
  expect(ran).toBe(false);
});

// SSP フォルダはドライブ文字で始まるローカルのパスに限る。乗っ取られた JS が UNC を渡すと、
// リモート共有上の ssp.exe を起動できてしまうため。ホスト名は予約済みの .invalid にする
// （拒否が外れて退行しても、実在のホストへは接続しない）
const UNC_SSP_PATHS = ["\\\\attacker.invalid\\share", "//attacker.invalid/share", "\\\\?\\UNC\\attacker.invalid\\share"];

test("SSP フォルダ: validate_ssp_path は UNC を拒否し、ローカルの試験用 SSP は通す", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  // 対照: 同じ経路でローカルの SSP は通る（以下の拒否が、呼び出し経路の不備によるものでないことの確認）
  const local = await invokeFromWebview(driver, "validate_ssp_path", { sspPath: fixtureSspPath() });
  expect(local).toEqual({ ok: true, value: null });

  for (const sspPath of UNC_SSP_PATHS) {
    const result = await invokeFromWebview(driver, "validate_ssp_path", { sspPath });
    expect(result, sspPath).toEqual({ ok: false, error: { kind: "sspPathNotLocal", path: sspPath } });
  }
});

test("SSP フォルダ: launch_ghost は UNC 上の ssp.exe を起動しない", async ({ harness }) => {
  const { driver } = harness;
  await waitForAppReady(driver);

  for (const sspPath of UNC_SSP_PATHS) {
    const result = await invokeFromWebview(driver, "launch_ghost", {
      sspPath,
      ghostDirectoryName: "ghost_e2e",
      ghostSource: "ssp",
    });
    expect(result, sspPath).toEqual({ ok: false, error: { kind: "sspPathNotLocal", path: sspPath } });
  }
});
