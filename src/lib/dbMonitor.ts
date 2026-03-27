import type Database from "@tauri-apps/plugin-sql";

const ALERT_GHOST_COUNT = 100_000;
const ALERT_P95_MS = 300;
const ALERT_DB_SIZE_BYTES = 100 * 1024 * 1024;
const RING_BUFFER_SIZE = 100;

let latencyBuffer: number[] = [];

export interface ScanStoreResult {
  cache_hit: boolean;
  total: number;
  fingerprint: string;
  request_key: string;
}

function emitLog(obj: Record<string, unknown>): void {
  console.log(`[dbMonitor] ${JSON.stringify(obj)}`);
}

function emitWarn(obj: Record<string, unknown>): void {
  console.warn(`[dbMonitor] ${JSON.stringify(obj)}`);
}

export function recordSearchLatency(durationMs: number): void {
  if (latencyBuffer.length >= RING_BUFFER_SIZE) {
    latencyBuffer.shift();
  }
  latencyBuffer.push(durationMs);
}

export function getP95SearchLatency(): number | null {
  if (latencyBuffer.length === 0) return null;
  const sorted = [...latencyBuffer].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

export async function measureSearch<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  const result = await fn();
  const durationMs = Math.round(performance.now() - start);
  recordSearchLatency(durationMs);
  const p95 = getP95SearchLatency();
  emitLog({ event: "search_latency", label, duration_ms: durationMs, p95_ms: p95 });
  if (p95 !== null && p95 > ALERT_P95_MS) {
    emitWarn({ event: "alert", kind: "search_p95_exceeded", p95_ms: p95, threshold_ms: ALERT_P95_MS });
  }
  return result;
}

export async function reportDbSize(db: Database, trigger: string): Promise<void> {
  try {
    const pageCountRows = await db.select<{ page_count: number }[]>("PRAGMA page_count");
    const pageSizeRows = await db.select<{ page_size: number }[]>("PRAGMA page_size");
    const pageCount = pageCountRows[0]?.page_count ?? 0;
    const pageSize = pageSizeRows[0]?.page_size ?? 4096;
    const sizeBytes = pageCount * pageSize;
    emitLog({ event: "db_size", trigger, size_bytes: sizeBytes });
    if (sizeBytes > ALERT_DB_SIZE_BYTES) {
      emitWarn({ event: "alert", kind: "db_size_exceeded", size_bytes: sizeBytes, threshold_bytes: ALERT_DB_SIZE_BYTES });
    }
  } catch (e) {
    console.warn("[dbMonitor] DB サイズ取得に失敗しました", e);
  }
}

export function reportScanComplete(result: ScanStoreResult, durationMs: number): void {
  emitLog({
    event: "scan_complete",
    request_key: result.request_key,
    total: result.total,
    cache_hit: result.cache_hit,
    duration_ms: durationMs,
  });
  if (result.total > ALERT_GHOST_COUNT) {
    emitWarn({ event: "alert", kind: "ghost_count_exceeded", total: result.total, threshold: ALERT_GHOST_COUNT });
  }
}
