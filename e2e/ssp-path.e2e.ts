import type { WebDriver } from "selenium-webdriver";
import { test, expect } from "./helpers/test";
import { fixtureSspPath } from "./helpers/fixture";
import { waitForAppReady } from "./helpers/ui";

// webview から受け取った SSP フォルダを、ドライブ文字で始まるローカルのパスに限ることを確かめる。
// 乗っ取られた JS が UNC を渡すと、リモート共有上の ssp.exe を起動できてしまうため。
// 既定の開始状態: 試験用 SSP を設定した日本語の状態
//
// ホスト名は予約済みの .invalid にする。拒否が外れて退行しても、実在のホストへは接続しない。

type InvokeResult = { ok: true; value: unknown } | { ok: false; error: unknown };

/// webview の中から Tauri のコマンドを直接呼ぶ（画面の操作を経ない、乗っ取られた JS の立場）。
/// コマンドのエラーは種別つきのオブジェクト（CommandError）なので、文字列化せずそのまま返す。
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
