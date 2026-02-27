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

const WD_SERVER = "http://127.0.0.1:4444/";

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

async function spawnTauriDriver(): Promise<ChildProcessWithoutNullStreams> {
  const tauriDriverPath = getTauriDriverPath();
  if (!(await fileExists(tauriDriverPath))) {
    throw new Error(
      `tauri-driver not found at ${tauriDriverPath}. Run: npm run e2e:setup`,
    );
  }
  const nativeDriverPath = await downloadEdgeDriver();
  const proc = spawn(tauriDriverPath, ["--native-driver", nativeDriverPath], {
    stdio: "pipe",
  });
  proc.on("error", () => {
    // ポートタイムアウトまたはセッション作成エラーで処理
  });
  await waitForPort(4444, 12_000);
  return proc;
}

async function createWebDriverSession(): Promise<WebDriver> {
  const appBinary = getAppBinaryPath();
  if (!(await fileExists(appBinary))) {
    throw new Error(
      `App binary not found at ${appBinary}. Run: npm run e2e:setup`,
    );
  }

  return new Builder()
    .usingServer(WD_SERVER)
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
    tauriDriver = await spawnTauriDriver();
    driver = await createWebDriverSession();
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
