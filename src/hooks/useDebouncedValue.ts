import { useEffect, useState } from "react";

/// 値の変更が delayMs 静止するまで反映を遅らせる。検索キー入力のクエリ発行を
/// 打鍵毎から「タイピングの区切り毎」に合流させる用途（Phase 1 の発行規律の続き）。
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
