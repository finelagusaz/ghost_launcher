import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FIXTURE_SSP_ENV, createFixtureSsp } from "./helpers/fixture";

/// 実行ごとに 1 回だけ試験用 SSP を作り、テストへ環境変数で渡す。終了時に削除する。
/// テストは試験用 SSP を読むだけで書き換えない（毎テストの初期化はデータ置き場だけで足りる）。
export default async function globalSetup(): Promise<() => Promise<void>> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ghost-launcher-e2e-"));
  process.env[FIXTURE_SSP_ENV] = await createFixtureSsp(root);
  return async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
}
