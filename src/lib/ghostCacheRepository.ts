import { settingsStore } from "./settingsStore";
import type { GhostCacheEntry, GhostCacheStoreV1 } from "../types";

export const GHOST_CACHE_KEY = "ghost_cache_v1";
const GHOST_CACHE_VERSION = 1 as const;
const MAX_CACHE_ENTRIES = 10;
let cacheWriteQueue: Promise<void> = Promise.resolve();

export function isGhostCacheStoreV1(value: unknown): value is GhostCacheStoreV1 {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<GhostCacheStoreV1>;
  return (
    candidate.version === GHOST_CACHE_VERSION &&
    !!candidate.entries &&
    typeof candidate.entries === "object" &&
    !Array.isArray(candidate.entries)
  );
}

function pruneOldEntries(store: GhostCacheStoreV1): void {
  const entries = Object.entries(store.entries);
  if (entries.length <= MAX_CACHE_ENTRIES) return;

  // cached_at 降順（新しい順）でソートし、上限を超えた古いエントリを削除
  entries.sort(([, a], [, b]) =>
    new Date(b.cached_at).getTime() - new Date(a.cached_at).getTime()
  );
  store.entries = Object.fromEntries(entries.slice(0, MAX_CACHE_ENTRIES));
}

async function readGhostCacheStore(): Promise<GhostCacheStoreV1> {
  const cached = await settingsStore.get<unknown>(GHOST_CACHE_KEY);
  if (isGhostCacheStoreV1(cached)) {
    return cached;
  }

  return {
    version: GHOST_CACHE_VERSION,
    entries: {},
  };
}

export async function readGhostCacheEntry(requestKey: string): Promise<GhostCacheEntry | undefined> {
  const cacheStore = await readGhostCacheStore();
  return cacheStore.entries[requestKey];
}

export async function writeGhostCacheEntry(
  requestKey: string,
  entry: GhostCacheEntry,
): Promise<void> {
  const runWrite = async () => {
    const cacheStore = await readGhostCacheStore();
    cacheStore.entries[requestKey] = entry;
    pruneOldEntries(cacheStore);
    await settingsStore.set(GHOST_CACHE_KEY, cacheStore);
    await settingsStore.save();
  };

  cacheWriteQueue = cacheWriteQueue.then(runWrite, runWrite);
  await cacheWriteQueue;
}
