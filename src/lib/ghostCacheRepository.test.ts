import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  isGhostCacheStoreV1,
  readGhostCacheEntry,
  writeGhostCacheEntry,
  GHOST_CACHE_KEY,
} from "./ghostCacheRepository";
import { settingsStore } from "./settingsStore";
import type { GhostCacheEntry } from "../types";

// settingsStore のインメモリ状態をリセットするヘルパー
function resetSettingsStore() {
  (settingsStore as unknown as { store: Record<string, unknown> }).store = {};
}

function makeEntry(cached_at: string): GhostCacheEntry {
  return {
    request_key: "key",
    fingerprint: "fp",
    ghosts: [],
    cached_at,
  };
}

describe("isGhostCacheStoreV1", () => {
  it("version=1 かつ entries が object の場合 true を返す", () => {
    expect(isGhostCacheStoreV1({ version: 1, entries: {} })).toBe(true);
  });
  it("version が異なる場合 false を返す", () => {
    expect(isGhostCacheStoreV1({ version: 2, entries: {} })).toBe(false);
  });
  it("null の場合 false を返す", () => {
    expect(isGhostCacheStoreV1(null)).toBe(false);
  });
  it("entries が存在しない場合 false を返す", () => {
    expect(isGhostCacheStoreV1({ version: 1 })).toBe(false);
  });
  it("entries が配列の場合 false を返す", () => {
    expect(isGhostCacheStoreV1({ version: 1, entries: [] })).toBe(false);
  });
});

describe("readGhostCacheEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSettingsStore();
  });

  it("キャッシュが空のとき undefined を返す", async () => {
    const result = await readGhostCacheEntry("nonexistent");
    expect(result).toBeUndefined();
  });

  it("ストアに存在するキーの entry を返す", async () => {
    const entry = makeEntry(new Date("2026-01-01T00:00:00Z").toISOString());
    await settingsStore.set(GHOST_CACHE_KEY, { version: 1, entries: { "key-1": entry } });

    const result = await readGhostCacheEntry("key-1");
    expect(result).toEqual(entry);
  });
});

describe("writeGhostCacheEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSettingsStore();
  });

  it("エントリを書き込み settingsStore.save を呼ぶ", async () => {
    const entry = makeEntry(new Date("2026-01-01T00:00:00Z").toISOString());
    await writeGhostCacheEntry("key-new", entry);

    const result = await readGhostCacheEntry("key-new");
    expect(result).toEqual(entry);
    expect(settingsStore.save).toHaveBeenCalledTimes(1);
  });

  it("10件以内では削除しない", async () => {
    // 9件 + 1件追加 = ちょうど上限。pruning が走らず key-0 は残るはず
    const entries: Record<string, GhostCacheEntry> = {};
    for (let i = 0; i < 9; i++) {
      entries[`key-${i}`] = makeEntry(new Date(2026, 0, i + 1).toISOString());
    }
    await settingsStore.set(GHOST_CACHE_KEY, { version: 1, entries });

    const newest = makeEntry(new Date("2026-02-01T00:00:00Z").toISOString());
    await writeGhostCacheEntry("key-new", newest);

    const survived = await readGhostCacheEntry("key-0");
    expect(survived).toBeDefined();
  });

  it("11件目を書き込むと最古のエントリが削除されて10件になる", async () => {
    const entries: Record<string, GhostCacheEntry> = {};
    // 10件を1時間ずつずらして登録（key-0 が最古）
    for (let i = 0; i < 10; i++) {
      const key = `key-${i}`;
      entries[key] = makeEntry(new Date(2026, 0, 1, i).toISOString());
    }
    await settingsStore.set(GHOST_CACHE_KEY, { version: 1, entries });

    // 11件目（最新）を書き込む
    const newest = makeEntry(new Date("2026-02-01T00:00:00Z").toISOString());
    await writeGhostCacheEntry("key-new", newest);

    // 新エントリが存在すること
    const newEntry = await readGhostCacheEntry("key-new");
    expect(newEntry).toBeDefined();

    // 最古の key-0 が削除されていること
    const deleted = await readGhostCacheEntry("key-0");
    expect(deleted).toBeUndefined();
  });
});
