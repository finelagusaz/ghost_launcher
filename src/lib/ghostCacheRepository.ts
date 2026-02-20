import { settingsStore } from "./settingsStore";
import type { GhostCacheEntry, GhostCacheStoreV1 } from "../types";

export const GHOST_CACHE_KEY = "ghost_cache_v1";
const GHOST_CACHE_VERSION = 1 as const;
let cacheWriteQueue: Promise<void> = Promise.resolve();

export function isGhostCacheStoreV1(value: unknown): value is GhostCacheStoreV1 {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<GhostCacheStoreV1>;
  return (
    candidate.version === GHOST_CACHE_VERSION &&
    !!candidate.entries &&
    typeof candidate.entries === "object"
  );
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
    await settingsStore.set(GHOST_CACHE_KEY, cacheStore);
    await settingsStore.save();
  };

  cacheWriteQueue = cacheWriteQueue.then(runWrite, runWrite);
  await cacheWriteQueue;
}
