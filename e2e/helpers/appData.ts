import { readFile, rm, mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";

/// E2E 専用ビルドの識別子（e2e/tauri.e2e.conf.json と同じ値）。
/// 設定・DB・ウィンドウ状態・webview の保存領域はすべてこの識別子でフォルダが決まる。
export const E2E_IDENTIFIER = "com.ghost-launcher.e2e";

/// 本番ビルドの識別子。E2E がこれを含むバイナリを起動すると、利用者の本物のデータを書き換える。
const PRODUCTION_IDENTIFIER = "com.ghost-launcher.desktop";

/// E2E 用のデータ置き場（Roaming: 設定・DB・ウィンドウ状態、Local: webview の保存領域）。
/// 環境変数が空のときに相対パスや親ディレクトリを指さないよう、ここで弾く。
export function e2eAppDataDirs(): string[] {
  const bases = [process.env.APPDATA, process.env.LOCALAPPDATA];
  return bases.map((base) => {
    if (!base || !path.isAbsolute(base)) {
      throw new Error("APPDATA / LOCALAPPDATA が絶対パスで定義されていません。E2E のデータ置き場を決められません");
    }
    return path.join(base, E2E_IDENTIFIER);
  });
}

const checkedBinaries = new Set<string>();

/// 起動しようとしているバイナリが E2E 専用ビルドであることを確かめる。
/// 本番ビルド（npm run tauri build の target/release）を誤って指していると、
/// 利用者の本物の設定・DB を書き換えるため、起動前に拒否する。
export async function assertE2eBinary(binaryPath: string): Promise<void> {
  if (checkedBinaries.has(binaryPath)) return;
  const bytes = await readFile(binaryPath);
  const hasE2e = bytes.includes(Buffer.from(E2E_IDENTIFIER));
  const hasProduction = bytes.includes(Buffer.from(PRODUCTION_IDENTIFIER));
  if (!hasE2e || hasProduction) {
    throw new Error(
      `${binaryPath} は E2E 専用ビルドではありません（識別子 ${E2E_IDENTIFIER} を含まないか、本番の識別子を含む）。` +
        "利用者の本物のデータを書き換えないよう起動を拒否しました。npm run e2e:build で作り直してください",
    );
  }
  checkedBinaries.add(binaryPath);
}

/// テスト開始時の設定（settings.json の中身）。null なら設定ファイルを置かない（初回起動の状態）。
export type E2eSettings = {
  ssp_path: string;
  ghost_folders?: string[];
  language?: "ja" | "en";
} | null;

/// 前のテストのアプリが終了したあとも、webview（WebView2）の子プロセスがしばらく残り、
/// データ置き場を掴み直すことがある。消えたことを確かめるまで待つ上限。
const RESET_DEADLINE_MS = 15_000;

/// E2E 用のデータ置き場を空にし、指定の設定を書いた状態にする。
/// 前のテストのプロセスがファイルを掴んでいると Windows では削除に失敗するため、消えたことを
/// 確かめるまで再試行する。上限を過ぎても残っていたら、黙って進めずに失敗させる
/// （前のテストの状態を引き継いだまま走らせない）。
export async function resetE2eAppData(settings: E2eSettings): Promise<void> {
  for (const dir of e2eAppDataDirs()) {
    if (path.basename(dir) !== E2E_IDENTIFIER) {
      throw new Error(`削除対象が E2E 用のデータ置き場ではありません: ${dir}`);
    }
    const deadline = Date.now() + RESET_DEADLINE_MS;
    let lastError: unknown;
    for (;;) {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (err) {
        lastError = err;
      }
      const remains = await access(dir).then(() => true, () => false);
      if (!remains) break;
      if (Date.now() > deadline) {
        throw new Error(`E2E 用のデータ置き場を消せませんでした: ${dir}`, { cause: lastError });
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  if (settings === null) return;
  const [roaming] = e2eAppDataDirs();
  await mkdir(roaming, { recursive: true });
  const content = {
    ssp_path: settings.ssp_path,
    ghost_folders: settings.ghost_folders ?? [],
    language: settings.language ?? "ja",
  };
  await writeFile(path.join(roaming, "settings.json"), JSON.stringify(content, null, 2), "utf8");
}
