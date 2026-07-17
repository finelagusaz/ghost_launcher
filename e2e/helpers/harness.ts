import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { download as downloadEdgeDriver } from "edgedriver";
import { Builder, type WebDriver } from "selenium-webdriver";

export type Harness = {
  driver: WebDriver;
  tauriDriver: ChildProcessWithoutNullStreams;
};

// tauri-driver の --port/--native-port は既定 4444/4445 の固定値。全テストで共有すると、
// Windows では kill() が子プロセス（msedgedriver）を道連れにしないため、前テストの
// 孤児 msedgedriver に次テストが相乗りし、孤児の遅延死で ECONNRESET になる（issue #153）。
// harness ごとに空きポートを取得して干渉を断つ。
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.once("error", reject);
  });
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function getAppBinaryPath(): string {
  const defaultName = process.platform === "win32" ? "ghost-launcher.exe" : "ghost-launcher";
  return process.env.GHOST_LAUNCHER_E2E_APP ?? path.resolve(process.cwd(), "src-tauri", "target", "release", defaultName);
}

function getTauriDriverPath(): string {
  const binaryName = process.platform === "win32" ? "tauri-driver.exe" : "tauri-driver";
  if (process.env.TAURI_DRIVER_PATH?.trim()) {
    return process.env.TAURI_DRIVER_PATH;
  }
  const cargoHome = process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo");
  return path.join(cargoHome, "bin", binaryName);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await sleep(120);
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

async function spawnTauriDriver(port: number, nativePort: number): Promise<ChildProcessWithoutNullStreams> {
  const tauriDriverPath = getTauriDriverPath();
  if (!(await fileExists(tauriDriverPath))) {
    throw new Error(
      `tauri-driver not found at ${tauriDriverPath}. Run: npm run e2e:setup`,
    );
  }
  // システム Edge とは独立に Tauri の WebView2 Runtime バージョンを
  // 指定したい場合は EDGEDRIVER_VERSION で上書き（例: "147.0.3912.98"）。
  // 既定の cacheDir（os.tmpdir()）は版に関係なく msedgedriver.exe を
  // キャッシュするため、版指定時はバージョン別ディレクトリへ分離する。
  const pinnedVersion = process.env.EDGEDRIVER_VERSION?.trim();
  const cacheDir = pinnedVersion
    ? path.join(os.tmpdir(), `edgedriver-${pinnedVersion}`)
    : undefined;
  const nativeDriverPath = await downloadEdgeDriver(pinnedVersion, cacheDir);
  const proc = spawn(
    tauriDriverPath,
    ["--native-driver", nativeDriverPath, "--port", String(port), "--native-port", String(nativePort)],
    { stdio: "pipe" },
  );
  proc.on("error", () => {
    // ポートタイムアウトまたはセッション作成エラーで処理
  });
  await waitForPort(port, 12_000);
  return proc;
}

async function createWebDriverSession(port: number): Promise<WebDriver> {
  const appBinary = getAppBinaryPath();
  if (!(await fileExists(appBinary))) {
    throw new Error(
      `App binary not found at ${appBinary}. Run: npm run e2e:setup`,
    );
  }

  return new Builder()
    .usingServer(`http://127.0.0.1:${port}/`)
    .withCapabilities({
      browserName: "wry",
      "tauri:options": {
        application: appBinary,
      },
    })
    .build();
}

export async function createHarness(): Promise<Harness> {
  let tauriDriver: ChildProcessWithoutNullStreams | undefined;
  let driver: WebDriver | undefined;
  try {
    const port = await getFreePort();
    const nativePort = await getFreePort();
    tauriDriver = await spawnTauriDriver(port, nativePort);
    driver = await createWebDriverSession(port);
    return { driver, tauriDriver };
  } catch (e) {
    if (driver) {
      await driver.quit().catch(() => {});
    }
    if (tauriDriver && !tauriDriver.killed) {
      tauriDriver.kill();
    }
    throw e;
  }
}

export async function disposeHarness(harness: Harness): Promise<void> {
  await harness.driver.quit().catch(() => {});
  if (!harness.tauriDriver.killed) {
    harness.tauriDriver.kill();
  }
}
