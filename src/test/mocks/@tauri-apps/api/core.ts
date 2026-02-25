// invoke のモック: テストごとに vi.mocked(invoke).mockResolvedValue(...) で制御
import { vi } from "vitest";
export const invoke = vi.fn();
