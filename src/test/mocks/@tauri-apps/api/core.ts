// invoke のモック: テストごとに vi.mocked(invoke).mockResolvedValue(...) で制御
import { vi } from "vitest";
export const invoke = vi.fn();
// convertFileSrc: ファイルパスを Tauri アセット URL に変換するモック
export const convertFileSrc = vi.fn((path: string) => `asset://localhost/${path}`);
