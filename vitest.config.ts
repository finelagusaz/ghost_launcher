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
    // Fluent UI 9.74.6 の ESM-first 化により @fluentui/* が type:module となり、
    // exports から node 条件が消えた（上流の意図的な変更）。その結果 react-tabster の
    // `import { createTabster } from 'tabster'` が静的 ESM 解決になるが、tabster は
    // exports を宣言せず main が CJS を指すため名前付き export を検出できず失敗する。
    // これは vitest 固有ではなく素の Node でも同じ（`node --input-type=module` で確認済み）。
    // Fluent UI の連鎖ごと Vite に処理させ、module フィールド経由で ESM を掴ませる。
    // tabster 単独の inline では import 元が externalize されたままのため効かない。詳細は #203。
    server: {
      deps: {
        inline: [/@fluentui\//, "tabster"],
      },
    },
  },
});
