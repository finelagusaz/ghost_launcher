import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { Ghost, GhostView } from "../types";

let dbInstance: Database | null = null;

async function loadDb(): Promise<Database> {
  const db = await Database.load("sqlite:ghosts.db");
  await db.execute("PRAGMA journal_mode=WAL");
  await db.execute("PRAGMA busy_timeout=5000");
  return db;
}

export async function getDb(): Promise<Database> {
  if (!dbInstance) {
    console.log("[ghostDatabase] Loading SQLite database...");
    try {
      dbInstance = await loadDb();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("migration") || msg.includes("duplicate column")) {
        console.warn("[ghostDatabase] マイグレーション競合を検出。DB をリセットします...", e);
        await invoke("reset_ghost_db");
        dbInstance = await loadDb();
        console.log("[ghostDatabase] DB をリセットして再接続しました");
      } else {
        throw e;
      }
    }
    console.log("[ghostDatabase] Database loaded successfully");
  }
  return dbInstance;
}

export async function clearGhostsByRequestKey(requestKey: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM ghosts WHERE request_key = ?", [requestKey]);
  console.log(`[ghostDatabase] Cleared ghosts table for requestKey=${requestKey}`);
}

export async function insertGhostsBatch(requestKey: string, ghosts: Ghost[]): Promise<void> {
  if (ghosts.length === 0) return;
  const db = await getDb();

  // SQLite の SQLITE_MAX_VARIABLE_NUMBER = 999。12列中プレースホルダ11個×90行=990で安全圏。
  const chunkSize = 90;
  let inserted = 0;
  for (let i = 0; i < ghosts.length; i += chunkSize) {
    const chunk = ghosts.slice(i, i + chunkSize);

    let sql = "INSERT INTO ghosts (request_key, name, craftman, directory_name, path, source, name_lower, directory_name_lower, thumbnail_path, thumbnail_use_self_alpha, thumbnail_kind, updated_at) VALUES ";
    const placeholders: string[] = [];
    const params: (string | number)[] = [];

    for (const ghost of chunk) {
      placeholders.push("(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)");
      params.push(requestKey);
      params.push(ghost.name);
      params.push(ghost.craftman);
      params.push(ghost.directory_name);
      params.push(ghost.path);
      params.push(ghost.source);
      params.push(ghost.name.normalize("NFKC").toLowerCase());
      params.push(ghost.directory_name.normalize("NFKC").toLowerCase());
      params.push(ghost.thumbnail_path);
      params.push(ghost.thumbnail_use_self_alpha ? 1 : 0);
      params.push(ghost.thumbnail_kind);
    }

    sql += placeholders.join(", ");
    await db.execute(sql, params);
    inserted += chunk.length;
  }
  console.log(`[ghostDatabase] Inserted ${inserted} ghosts into SQLite for requestKey=${requestKey}`);
}

// tauri-plugin-sql は sqlx コネクションプール（max_connections=10）を使用するため、
// 複数の execute() 呼び出しが異なるコネクションに到達しうる。
// 明示的トランザクション（BEGIN/COMMIT/ROLLBACK）はコネクション間で共有されず
// SQLITE_BUSY を引き起こすため、各操作を auto-commit で実行する。
// キャッシュ DB のため、中断時はフルスキャンで復旧可能。
export async function replaceGhostsByRequestKey(requestKey: string, ghosts: Ghost[]): Promise<void> {
  await clearGhostsByRequestKey(requestKey);
  await insertGhostsBatch(requestKey, ghosts);
  console.log(`[ghostDatabase] Replaced ghosts for requestKey=${requestKey}`);
}

interface RequestKeyRow {
  request_key: string;
  last_updated: string;
}

function buildInClausePlaceholders(length: number): string {
  return new Array(length).fill("?").join(", ");
}

export async function cleanupOldGhostCaches(
  currentRequestKey: string,
  maxGenerations = 5,
  ttlDays = 30,
): Promise<string[]> {
  const db = await getDb();

  const rows = await db.select<RequestKeyRow[]>(
    "SELECT request_key, MAX(updated_at) AS last_updated FROM ghosts GROUP BY request_key ORDER BY last_updated DESC"
  );

  const ttlCutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  const keepByGeneration = new Set<string>(rows.slice(0, Math.max(0, maxGenerations)).map((r) => r.request_key));
  keepByGeneration.add(currentRequestKey);

  const keepRequestKeys: string[] = [];
  const deleteRequestKeys: string[] = [];

  for (const row of rows) {
    const lastUpdated = Date.parse(row.last_updated);
    const ttlExpired = Number.isNaN(lastUpdated) ? false : lastUpdated < ttlCutoff;
    const keep =
      (keepByGeneration.has(row.request_key) && !ttlExpired) ||
      row.request_key === currentRequestKey;
    if (keep) {
      keepRequestKeys.push(row.request_key);
    } else {
      deleteRequestKeys.push(row.request_key);
    }
  }

  if (deleteRequestKeys.length > 0) {
    const placeholders = buildInClausePlaceholders(deleteRequestKeys.length);
    await db.execute(`DELETE FROM ghosts WHERE request_key IN (${placeholders})`, deleteRequestKeys);
    console.log(`[ghostDatabase] Cleaned ${deleteRequestKeys.length} stale request_key caches`);
  }

  if (!keepRequestKeys.includes(currentRequestKey)) {
    keepRequestKeys.push(currentRequestKey);
  }
  return keepRequestKeys;
}

export async function hasGhosts(requestKey: string): Promise<boolean> {
  const db = await getDb();
  const countResult = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM ghosts WHERE request_key = ?",
    [requestKey]
  );
  const total = countResult.length > 0 ? countResult[0].count : 0;
  return total > 0;
}

export async function searchGhostsInitialPage(requestKey: string, limit: number): Promise<GhostView[]> {
  const db = await getDb();
  const rows = await db.select<GhostView[]>(
    "SELECT name, craftman, directory_name, path, source, name_lower, directory_name_lower, thumbnail_path, thumbnail_use_self_alpha, thumbnail_kind FROM ghosts WHERE request_key = ? ORDER BY name_lower ASC LIMIT ?",
    [requestKey, limit]
  );

  console.log(`[ghostDatabase] searchGhostsInitialPage(requestKey=${requestKey}, limit=${limit}) → rows=${rows.length}`);
  return rows;
}

export async function countGhostsByQuery(requestKey: string, query: string): Promise<number> {
  const db = await getDb();
  const normalizedQuery = query.normalize("NFKC").toLowerCase();

  let countResult: { count: number }[];
  if (normalizedQuery === "") {
    countResult = await db.select<{ count: number }[]>(
      "SELECT COUNT(*) as count FROM ghosts WHERE request_key = ?",
      [requestKey]
    );
  } else {
    const likePattern = `%${normalizedQuery}%`;
    countResult = await db.select<{ count: number }[]>(
      "SELECT COUNT(*) as count FROM ghosts WHERE request_key = ? AND (name_lower LIKE ? OR directory_name_lower LIKE ?)",
      [requestKey, likePattern, likePattern]
    );
  }

  return countResult.length > 0 ? countResult[0].count : 0;
}

export async function searchGhosts(requestKey: string, query: string, limit: number, offset: number): Promise<{ ghosts: GhostView[], total: number }> {
  const db = await getDb();

  const normalizedQuery = query.normalize("NFKC").toLowerCase();
  const likePattern = `%${normalizedQuery}%`;
  const total = await countGhostsByQuery(requestKey, query);
  console.log(`[ghostDatabase] searchGhosts(requestKey=${requestKey}, query="${query}", limit=${limit}, offset=${offset}) → total=${total}`);

  const rows = await db.select<GhostView[]>(
    "SELECT name, craftman, directory_name, path, source, name_lower, directory_name_lower, thumbnail_path, thumbnail_use_self_alpha, thumbnail_kind FROM ghosts WHERE request_key = ? AND (name_lower LIKE ? OR directory_name_lower LIKE ?) ORDER BY name_lower ASC LIMIT ? OFFSET ?",
    [requestKey, likePattern, likePattern, limit, offset]
  );

  console.log(`[ghostDatabase] Fetched ${rows.length} rows`);
  return { ghosts: rows, total };
}
