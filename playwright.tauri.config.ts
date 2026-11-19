import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  // 試験用 SSP を実行ごとに 1 回作り、終了時に消す
  globalSetup: "./e2e/global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  // 不変条件: 全テストが E2E 用のデータ置き場を 1 つ共有し、テストごとに消して作り直すため並行に走らせない
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
});
