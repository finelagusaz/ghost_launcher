import { describe, it, expect, vi, beforeEach } from "vitest";

// settingsStore モジュールをリセットして毎回新しいインスタンスを取得する
beforeEach(() => {
  vi.resetModules();
});

describe("warmUpSettingsStore", () => {
  it("settingsStore.init を呼び出す", async () => {
    const { settingsStore, warmUpSettingsStore } = await import("./settingsStore");
    warmUpSettingsStore();
    // init は fire-and-forget なので呼ばれたかだけ確認
    expect(settingsStore.init).toHaveBeenCalledTimes(1);
  });
});
