import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Tauri API のモック差し替え（テスト環境のみ有効）
      "@tauri-apps/api/core": resolve(__dirname, "src/test/mocks/@tauri-apps/api/core.ts"),
      "@tauri-apps/plugin-store": resolve(__dirname, "src/test/mocks/@tauri-apps/plugin-store.ts"),
      "@tauri-apps/plugin-dialog": resolve(__dirname, "src/test/mocks/@tauri-apps/plugin-dialog.ts"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    // globals は使用しない（各テストファイルで明示的に import する）
    // scripts/ は Node.js --test 用なので vitest の対象から除外する
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
