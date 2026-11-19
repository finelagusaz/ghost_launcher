import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRecordLaunch } = vi.hoisted(() => ({ mockRecordLaunch: vi.fn() }));
vi.mock("./ghostDatabase", () => ({ recordLaunch: mockRecordLaunch }));

beforeEach(() => {
  vi.resetModules();
  mockRecordLaunch.mockReset();
  mockRecordLaunch.mockResolvedValue(undefined);
});

const ghost = { directory_name: "my_ghost", source: "ssp", ghost_identity_key: "sspmy_ghost" };

describe("sspClient", () => {
  it("launchGhost が launch_ghost IPC を camelCase 引数で呼び、履歴を記録する", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const { launchGhost } = await import("./sspClient");
    await launchGhost("C:\\SSP", ghost);
    expect(invoke).toHaveBeenCalledWith("launch_ghost", {
      sspPath: "C:\\SSP",
      ghostDirectoryName: "my_ghost",
      ghostSource: "ssp",
    });
    expect(mockRecordLaunch).toHaveBeenCalledWith("sspmy_ghost");
  });

  it("ghost_identity_key が空なら履歴を記録しない", async () => {
    const { launchGhost } = await import("./sspClient");
    await launchGhost("C:\\SSP", { ...ghost, ghost_identity_key: "" });
    expect(mockRecordLaunch).not.toHaveBeenCalled();
  });

  it("履歴記録の失敗は起動成功を妨げない", async () => {
    mockRecordLaunch.mockRejectedValue(new Error("db down"));
    const { launchGhost } = await import("./sspClient");
    await expect(launchGhost("C:\\SSP", ghost)).resolves.toBeUndefined();
  });

  it("起動履歴の記録が成功してから購読者へ通知する（集計列の更新より先に読ませない）", async () => {
    let resolveRecord: () => void = () => {};
    mockRecordLaunch.mockReturnValue(new Promise<void>((r) => { resolveRecord = r; }));
    const { launchGhost, subscribeLaunchRecorded } = await import("./sspClient");
    const listener = vi.fn();
    subscribeLaunchRecorded(listener);

    await launchGhost("C:\\SSP", ghost);
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();

    resolveRecord();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
  });

  it("起動履歴の記録に失敗したら通知しない", async () => {
    mockRecordLaunch.mockRejectedValue(new Error("db down"));
    const { launchGhost, subscribeLaunchRecorded } = await import("./sspClient");
    const listener = vi.fn();
    subscribeLaunchRecorded(listener);

    await launchGhost("C:\\SSP", ghost);
    await new Promise((r) => setTimeout(r, 0));
    expect(listener).not.toHaveBeenCalled();
  });

  it("ghost_identity_key が空なら通知しない", async () => {
    const { launchGhost, subscribeLaunchRecorded } = await import("./sspClient");
    const listener = vi.fn();
    subscribeLaunchRecorded(listener);

    await launchGhost("C:\\SSP", { ...ghost, ghost_identity_key: "" });
    await new Promise((r) => setTimeout(r, 0));
    expect(listener).not.toHaveBeenCalled();
  });

  it("購読を解除すると通知しない", async () => {
    const { launchGhost, subscribeLaunchRecorded } = await import("./sspClient");
    const listener = vi.fn();
    const unsubscribe = subscribeLaunchRecorded(listener);
    unsubscribe();

    await launchGhost("C:\\SSP", ghost);
    await new Promise((r) => setTimeout(r, 0));
    expect(listener).not.toHaveBeenCalled();
  });

  it("validateSspPath が validate_ssp_path IPC を呼ぶ", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const { validateSspPath } = await import("./sspClient");
    await validateSspPath("C:\\SSP");
    expect(invoke).toHaveBeenCalledWith("validate_ssp_path", { sspPath: "C:\\SSP" });
  });
});
