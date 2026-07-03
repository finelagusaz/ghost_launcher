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

  it("validateSspPath が validate_ssp_path IPC を呼ぶ", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const { validateSspPath } = await import("./sspClient");
    await validateSspPath("C:\\SSP");
    expect(invoke).toHaveBeenCalledWith("validate_ssp_path", { sspPath: "C:\\SSP" });
  });
});
