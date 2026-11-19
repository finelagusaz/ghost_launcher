// invoke のモック: テストごとに vi.mocked(invoke).mockResolvedValue(...) で制御
import { vi } from "vitest";
export const invoke = vi.fn();
// convertFileSrc: ファイルパスを Tauri のプロトコル URL に変換するモック（既定は asset）
export const convertFileSrc = vi.fn((path: string, protocol = "asset") => `${protocol}://localhost/${path}`);
