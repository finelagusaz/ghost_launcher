import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FIXTURE_SSP_ENV, NUMBERED_GHOST_COUNT, createFixtureSsp } from "./helpers/fixture";

/// 試験用 SSP が本番の 1 ページ（src/App.tsx の LIMIT）を超えることを確かめる。
/// 超えないと、スクロールのテストが先読みのページ送りを通らないまま通ってしまう。
async function assertFixtureExceedsPage(): Promise<void> {
  const app = await readFile(path.resolve(process.cwd(), "src", "App.tsx"), "utf8");
  const match = app.match(/const LIMIT = (\d+);/);
  if (!match) {
    throw new Error("src/App.tsx から 1 ページの件数（const LIMIT）を読めません。fixture の件数を照合できません");
  }
  const limit = Number(match[1]);
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
  await assertFixtureExceedsPage();
  const root = await mkdtemp(path.join(os.tmpdir(), "ghost-launcher-e2e-"));
  process.env[FIXTURE_SSP_ENV] = await createFixtureSsp(root);
  return async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
}
