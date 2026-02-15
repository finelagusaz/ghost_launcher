import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { settingsStore } from "../lib/settingsStore";
import type {
  Ghost,
  GhostCacheEntry,
  GhostCacheStoreV1,
  GhostView,
  ScanGhostsResponse,
} from "../types";

const pendingScans = new Map<string, Promise<ScanGhostsResponse>>();
const GHOST_CACHE_KEY = "ghost_cache_v1";
const GHOST_CACHE_VERSION = 1 as const;

interface RefreshOptions {
  forceFullScan?: boolean;
}

function normalizePathKey(path: string): string {
  return path.trim().replace(/\\/g, "/").toLowerCase();
}

function buildAdditionalFolders(folders: string[]): string[] {
  const sorted = folders
    .map((folder) => ({ raw: folder, key: normalizePathKey(folder) }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const unique: string[] = [];
  let lastKey: string | null = null;

  for (const folder of sorted) {
    if (folder.key === lastKey) continue;
    unique.push(folder.raw);
    lastKey = folder.key;
  }

  return unique;
}

function buildRequestKey(sspPath: string, additionalFolders: string[]): string {
  const normalizedSspPath = normalizePathKey(sspPath);
  const normalizedFolders = additionalFolders.map((folder) =>
    normalizePathKey(folder),
  );
  return `${normalizedSspPath}::${normalizedFolders.join("|")}`;
}

function isGhostCacheStoreV1(value: unknown): value is GhostCacheStoreV1 {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<GhostCacheStoreV1>;
  return candidate.version === GHOST_CACHE_VERSION && !!candidate.entries && typeof candidate.entries === "object";
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

async function writeGhostCacheEntry(requestKey: string, entry: GhostCacheEntry): Promise<void> {
  const cacheStore = await readGhostCacheStore();
  cacheStore.entries[requestKey] = entry;
  await settingsStore.set(GHOST_CACHE_KEY, cacheStore);
  await settingsStore.save();
}

function toGhostView(ghost: Ghost): GhostView {
  return {
    ...ghost,
    name_lower: ghost.name.toLowerCase(),
    directory_name_lower: ghost.directory_name.toLowerCase(),
  };
}

function buildScanErrorMessage(error: unknown): string {
  const detail =
    error instanceof Error ? error.message.trim() : String(error).trim();
  const detailText = detail ? `（詳細: ${detail}）` : "";
  return `ゴースト一覧の取得に失敗しました。SSPフォルダと追加フォルダを確認して「再読込」を実行してください。${detailText}`;
}

export function useGhosts(sspPath: string | null, ghostFolders: string[]) {
  const [ghosts, setGhosts] = useState<GhostView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightKeyRef = useRef<string | null>(null);
  const requestSeqRef = useRef(0);

  const refresh = useCallback(async (options: RefreshOptions = {}) => {
    if (!sspPath) {
      setGhosts([]);
      setError(null);
      setLoading(false);
      return;
    }

    const additionalFolders = buildAdditionalFolders(ghostFolders);
    const requestKey = buildRequestKey(sspPath, additionalFolders);
    const forceFullScan = options.forceFullScan === true;
    const inFlightKey = `${requestKey}::${forceFullScan ? "force" : "auto"}`;

    if (inFlightKeyRef.current === inFlightKey) {
      return;
    }

    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    inFlightKeyRef.current = inFlightKey;

    let usedCachedGhosts = false;
    let cachedEntry: GhostCacheEntry | undefined;

    try {
      setError(null);

      if (!forceFullScan) {
        const cacheStore = await readGhostCacheStore();
        cachedEntry = cacheStore.entries[requestKey];

        if (requestSeq !== requestSeqRef.current) {
          return;
        }

        if (cachedEntry) {
          usedCachedGhosts = true;
          setGhosts(cachedEntry.ghosts.map(toGhostView));
        }
      }

      setLoading(!usedCachedGhosts);

      if (!forceFullScan && cachedEntry) {
        try {
          const fingerprint = await invoke<string>("get_ghosts_fingerprint", {
            sspPath,
            additionalFolders,
          });
          if (requestSeq !== requestSeqRef.current) {
            return;
          }

          if (fingerprint === cachedEntry.fingerprint) {
            return;
          }
        } catch {
          // 指紋取得に失敗した場合はフルスキャンへフォールバックする。
        }
      }

      let scanPromise = pendingScans.get(requestKey);
      if (!scanPromise || forceFullScan) {
        scanPromise = invoke<ScanGhostsResponse>("scan_ghosts_with_meta", {
          sspPath,
          additionalFolders,
        });
        pendingScans.set(requestKey, scanPromise);
        scanPromise.finally(() => {
          if (pendingScans.get(requestKey) === scanPromise) {
            pendingScans.delete(requestKey);
          }
        });
      }

      const result = await scanPromise;
      if (requestSeq === requestSeqRef.current) {
        setGhosts(result.ghosts.map(toGhostView));
        setError(null);
      }

      await writeGhostCacheEntry(requestKey, {
        request_key: requestKey,
        fingerprint: result.fingerprint,
        ghosts: result.ghosts,
        cached_at: new Date().toISOString(),
      });
    } catch (e) {
      if (requestSeq === requestSeqRef.current) {
        if (!usedCachedGhosts || forceFullScan) {
          setError(buildScanErrorMessage(e));
          setGhosts([]);
        }
      }
    } finally {
      if (requestSeq === requestSeqRef.current) {
        setLoading(false);
      }
      if (inFlightKeyRef.current === inFlightKey) {
        inFlightKeyRef.current = null;
      }
    }
  }, [sspPath, ghostFolders]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ghosts, loading, error, refresh };
}
