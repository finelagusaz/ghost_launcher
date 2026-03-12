import { LazyStore } from "@tauri-apps/plugin-store";

export const settingsStore = new LazyStore("settings.json");

/// LazyStore の初期化を早期にキックオフする（fire-and-forget）。
/// React のレンダリング開始前に呼ぶことで、最初の設定読み込みを高速化する。
export function warmUpSettingsStore(): void {
  void settingsStore.init();
}
