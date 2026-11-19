import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ghostListConfig from "../src/config/ghost-list.json" with { type: "json" };
import { FIXTURE_SSP_ENV, NUMBERED_GHOST_COUNT, createFixtureSsp } from "./helpers/fixture";

/// 試験用 SSP が本番の 1 ページ（src/config/ghost-list.json の pageLimit）を超えることを確かめる。
/// 超えないと、スクロールのテストが先読みのページ送りを通らないまま通ってしまう。
function assertFixtureExceedsPage(): void {
  const limit = ghostListConfig.pageLimit;
  if (NUMBERED_GHOST_COUNT <= limit) {
    throw new Error(
      `試験用 SSP の件数（${NUMBERED_GHOST_COUNT}）が本番の 1 ページ（${limit}）を超えていません。` +
        "e2e/helpers/fixture.ts の NUMBERED_GHOST_COUNT を増やしてください",
    );
  }
}

/// 実行ごとに 1 回だけ試験用 SSP を作り、テストへ環境変数で渡す。終了時に削除する。
/// テストは試験用 SSP を読むだけで書き換えない（毎テストの初期化はデータ置き場だけで足りる）。
export default async function globalSetup(): Promise<() => Promise<void>> {
  assertFixtureExceedsPage();
  const root = await mkdtemp(path.join(os.tmpdir(), "ghost-launcher-e2e-"));
  process.env[FIXTURE_SSP_ENV] = await createFixtureSsp(root);
  return async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
}
