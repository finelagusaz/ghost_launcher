// E2E 専用のリリースビルドを作る（npm run e2e:build）。
//
// 識別子を com.ghost-launcher.e2e に差し替える（e2e/tauri.e2e.conf.json）。設定・DB・ウィンドウ状態・
// webview の保存領域はすべて識別子でフォルダが決まるため、E2E が利用者の本物のデータに触れない。
// 識別子はビルド時に埋め込まれるので、本番ビルド（target/release）とは別の出力先（target/e2e）へ置き、
// 互いに上書きしない。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const result = spawnSync(
  "npx",
  ["tauri", "build", "--no-bundle", "--config", path.join("e2e", "tauri.e2e.conf.json")],
  {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, CARGO_TARGET_DIR: path.join(root, "target", "e2e") },
  },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
