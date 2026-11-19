import { test as base } from "@playwright/test";
import type { E2eSettings } from "./appData";
import { createHarness, disposeHarness, type Harness } from "./harness";

/// E2E 共通の test。テストごとに E2E 用のデータ置き場を初期化してからアプリを起動する。
/// 開始時の設定は `test.use({ settings: ... })` で選ぶ（既定: 試験用 SSP を設定した日本語の状態、
/// null: 設定ファイルなしの初回起動）。
export const test = base.extend<{ settings: E2eSettings | undefined; harness: Harness }>({
  settings: [undefined, { option: true }],
  harness: async ({ settings }, use) => {
    const harness = await createHarness({ settings });
    try {
      await use(harness);
    } finally {
      await disposeHarness(harness);
    }
  },
});

export { expect } from "@playwright/test";
