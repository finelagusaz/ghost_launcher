import { useEffect, useState } from "react";

/** スキャン中インジケータを表示し始めるまでの遅延（ちらつき防止）。 */
export const SCAN_INDICATOR_DELAY_MS = 300;

/**
 * `active` が SCAN_INDICATOR_DELAY_MS 以上継続したときだけ true を返す。
 * `active` が false になった瞬間は即 false（保留中タイマーは解除）。
 * Layer 1 ヒットや warm な瞬間再スキャンでバーが点滅するのを防ぐ。
 */
export function useScanIndicator(active: boolean): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), SCAN_INDICATOR_DELAY_MS);
    return () => clearTimeout(timer);
  }, [active]);

  return visible;
}
