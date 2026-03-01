import Database from "@tauri-apps/plugin-sql";
import { Ghost, GhostView } from "../types";

let dbInstance: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!dbInstance) {
    console.log("[ghostDatabase] Loading SQLite database...");
    dbInstance = await Database.load("sqlite:ghosts.db");
    await dbInstance.execute("PRAGMA journal_mode=WAL");
    await dbInstance.execute("PRAGMA busy_timeout=5000");
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

  // SQLite の SQLITE_MAX_VARIABLE_NUMBER = 999。7列×100行=700で安全圏。
  const chunkSize = 100;
  let inserted = 0;
  for (let i = 0; i < ghosts.length; i += chunkSize) {
    const chunk = ghosts.slice(i, i + chunkSize);

    let sql = "INSERT INTO ghosts (request_key, name, craftman, directory_name, path, source, name_lower, directory_name_lower, updated_at) VALUES ";
    const placeholders: string[] = [];
    const params: string[] = [];

    for (const ghost of chunk) {
      placeholders.push("(?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)");
      params.push(requestKey);
      params.push(ghost.name);
      params.push(ghost.craftman);
      params.push(ghost.directory_name);
      params.push(ghost.path);
      params.push(ghost.source);
      params.push(ghost.name.normalize("NFKC").toLowerCase());
      params.push(ghost.directory_name.normalize("NFKC").toLowerCase());
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
export async function searchGhosts(requestKey: string, query: string, limit: number, offset: number): Promise<{ ghosts: GhostView[], total: number }> {
  const db = await getDb();

  const likePattern = `%${query.normalize("NFKC").toLowerCase()}%`;

  // SQLite では ? プレースホルダを使う ($1/$2 は PostgreSQL 構文)
  const countResult = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM ghosts WHERE request_key = ? AND (name_lower LIKE ? OR directory_name_lower LIKE ?)",
    [requestKey, likePattern, likePattern]
  );

  const total = countResult.length > 0 ? countResult[0].count : 0;
  console.log(`[ghostDatabase] searchGhosts(requestKey=${requestKey}, query="${query}", limit=${limit}, offset=${offset}) → total=${total}`);

  const rows = await db.select<GhostView[]>(
    "SELECT name, craftman, directory_name, path, source, name_lower, directory_name_lower FROM ghosts WHERE request_key = ? AND (name_lower LIKE ? OR directory_name_lower LIKE ?) ORDER BY name_lower ASC LIMIT ? OFFSET ?",
    [requestKey, likePattern, likePattern, limit, offset]
  );

  console.log(`[ghostDatabase] Fetched ${rows.length} rows`);
  return { ghosts: rows, total };
}
