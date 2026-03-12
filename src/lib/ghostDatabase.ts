import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { Ghost, GhostView } from "../types";

let dbInstance: Database | null = null;

const VACUUM_FREE_RATIO = 0.25;
const VACUUM_FREE_BYTES = 1_048_576;

async function vacuumIfNeeded(db: Database): Promise<void> {
  const pageCountRows = await db.select<{ page_count: number }[]>("PRAGMA page_count");
  const freelistRows = await db.select<{ freelist_count: number }[]>("PRAGMA freelist_count");
  const pageCount = pageCountRows[0]?.page_count ?? 0;
  const freelistCount = freelistRows[0]?.freelist_count ?? 0;

  if (pageCount === 0) return;

  const pageSizeRows = await db.select<{ page_size: number }[]>("PRAGMA page_size");
  const pageSize = pageSizeRows[0]?.page_size ?? 4096;
  const freeBytes = freelistCount * pageSize;
  const freeRatio = freelistCount / pageCount;

  if (freeRatio >= VACUUM_FREE_RATIO && freeBytes >= VACUUM_FREE_BYTES) {
    console.log(
      `[ghostDatabase] VACUUM 実行: 未使用率=${(freeRatio * 100).toFixed(1)}%, 未使用=${(freeBytes / 1024 / 1024).toFixed(1)}MB`
    );
    await db.execute("VACUUM");
  }
}

async function loadDb(): Promise<Database> {
  const db = await Database.load("sqlite:ghosts.db");
  await db.execute("PRAGMA journal_mode=WAL");
  await db.execute("PRAGMA busy_timeout=5000");
  await db.execute("PRAGMA journal_size_limit=4194304");
  await db.execute("PRAGMA optimize=0x10002");
  await vacuumIfNeeded(db);
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

const GHOST_KEY_SEPARATOR = "\u001f";

function normalizeForKey(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function buildGhostIdentityKey(ghost: Ghost): string {
  return `${normalizeForKey(ghost.source)}${GHOST_KEY_SEPARATOR}${normalizeForKey(ghost.directory_name)}`;
}

function buildGhostDiffFingerprint(ghost: Ghost): string {
  if (ghost.diff_fingerprint) {
    return ghost.diff_fingerprint;
  }
  return [
    ghost.name,
    ghost.sakura_name,
    ghost.kero_name,
    ghost.craftman,
    ghost.craftmanw,
    ghost.path,
    ghost.thumbnail_path,
    ghost.thumbnail_use_self_alpha ? "1" : "0",
    ghost.thumbnail_kind,
  ].join(GHOST_KEY_SEPARATOR);
}

const GHOST_INSERT_SQL_PREFIX =
  "INSERT INTO ghosts (request_key, ghost_identity_key, row_fingerprint, name, sakura_name, kero_name, craftman, craftmanw, directory_name, path, source, name_lower, sakura_name_lower, kero_name_lower, craftman_lower, craftmanw_lower, directory_name_lower, thumbnail_path, thumbnail_use_self_alpha, thumbnail_kind, updated_at) VALUES ";

const GHOST_INSERT_PLACEHOLDER = "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)";

function buildGhostInsertRow(requestKey: string, ghost: Ghost): { identityKey: string; params: (string | number)[] } {
  const identityKey = buildGhostIdentityKey(ghost);
  return {
    identityKey,
    params: [
      requestKey,
      identityKey,
      buildGhostDiffFingerprint(ghost),
      ghost.name,
      ghost.sakura_name,
      ghost.kero_name,
      ghost.craftman,
      ghost.craftmanw,
      ghost.directory_name,
      ghost.path,
      ghost.source,
      normalizeForKey(ghost.name),
      normalizeForKey(ghost.sakura_name),
      normalizeForKey(ghost.kero_name),
      normalizeForKey(ghost.craftman),
      normalizeForKey(ghost.craftmanw),
      normalizeForKey(ghost.directory_name),
      ghost.thumbnail_path,
      ghost.thumbnail_use_self_alpha ? 1 : 0,
      ghost.thumbnail_kind,
    ],
  };
}

export async function insertGhostsBatch(requestKey: string, ghosts: Ghost[]): Promise<void> {
  if (ghosts.length === 0) return;
  const db = await getDb();

  // SQLite の SQLITE_MAX_VARIABLE_NUMBER = 999。14列中プレースホルダ13個×75行=975で安全圏。
  const chunkSize = 75;
  let inserted = 0;
  for (let i = 0; i < ghosts.length; i += chunkSize) {
    const chunk = ghosts.slice(i, i + chunkSize);
    const placeholders: string[] = [];
    const params: (string | number)[] = [];

    for (const ghost of chunk) {
      const row = buildGhostInsertRow(requestKey, ghost);
      placeholders.push(GHOST_INSERT_PLACEHOLDER);
      params.push(...row.params);
    }

    await db.execute(GHOST_INSERT_SQL_PREFIX + placeholders.join(", "), params);
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
  // NOT IN の変数上限: SQLITE_MAX_VARIABLE_NUMBER(999) から request_key の 1 を引いた最大。
  // 998 件超はゴーストが極めて多いレアケースのため全削除→再挿入にフォールバックする。
  const NOT_IN_MAX = 998;
  if (ghosts.length > NOT_IN_MAX) {
    await clearGhostsByRequestKey(requestKey);
    await insertGhostsBatch(requestKey, ghosts);
    console.log(`[ghostDatabase] Replaced ghosts (full reset) for requestKey=${requestKey}`);
    return;
  }

  const db = await getDb();

  // tauri-plugin-sql はトランザクション境界を共有できないため、
  // upsert と不要行削除を auto-commit で順次実行する。
  const chunkSize = 75;
  const keepKeys: string[] = [];

  for (let i = 0; i < ghosts.length; i += chunkSize) {
    const chunk = ghosts.slice(i, i + chunkSize);
    const placeholders: string[] = [];
    const params: (string | number)[] = [];

    for (const ghost of chunk) {
      const row = buildGhostInsertRow(requestKey, ghost);
      keepKeys.push(row.identityKey);
      placeholders.push(GHOST_INSERT_PLACEHOLDER);
      params.push(...row.params);
    }

    let sql = GHOST_INSERT_SQL_PREFIX + placeholders.join(", ");
    sql += " ON CONFLICT(request_key, ghost_identity_key) DO UPDATE SET ";
    sql += "row_fingerprint = excluded.row_fingerprint, ";
    sql += "name = excluded.name, sakura_name = excluded.sakura_name, kero_name = excluded.kero_name, ";
    sql += "craftman = excluded.craftman, craftmanw = excluded.craftmanw, directory_name = excluded.directory_name, ";
    sql += "path = excluded.path, source = excluded.source, name_lower = excluded.name_lower, ";
    sql += "sakura_name_lower = excluded.sakura_name_lower, kero_name_lower = excluded.kero_name_lower, ";
    sql += "craftman_lower = excluded.craftman_lower, craftmanw_lower = excluded.craftmanw_lower, ";
    sql += "directory_name_lower = excluded.directory_name_lower, thumbnail_path = excluded.thumbnail_path, ";
    sql += "thumbnail_use_self_alpha = excluded.thumbnail_use_self_alpha, thumbnail_kind = excluded.thumbnail_kind, ";
    sql += "updated_at = CURRENT_TIMESTAMP ";
    sql += "WHERE ghosts.row_fingerprint <> excluded.row_fingerprint";

    await db.execute(sql, params);
  }

  if (keepKeys.length > 0) {
    const placeholders = buildInClausePlaceholders(keepKeys.length);
    await db.execute(
      `DELETE FROM ghosts WHERE request_key = ? AND ghost_identity_key NOT IN (${placeholders})`,
      [requestKey, ...keepKeys],
    );
  } else {
    await clearGhostsByRequestKey(requestKey);
  }

  console.log(`[ghostDatabase] Upserted ghosts and pruned stale rows for requestKey=${requestKey}`);
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
): Promise<void> {
  const db = await getDb();

  const rows = await db.select<RequestKeyRow[]>(
    "SELECT request_key, MAX(updated_at) AS last_updated FROM ghosts GROUP BY request_key ORDER BY last_updated DESC"
  );

  const ttlCutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  const keepByGeneration = new Set<string>(rows.slice(0, Math.max(0, maxGenerations)).map((r) => r.request_key));
  keepByGeneration.add(currentRequestKey);

  const deleteRequestKeys: string[] = [];

  for (const row of rows) {
    const lastUpdated = Date.parse(row.last_updated);
    const ttlExpired = Number.isNaN(lastUpdated) ? false : lastUpdated < ttlCutoff;
    const keep =
      (keepByGeneration.has(row.request_key) && !ttlExpired) ||
      row.request_key === currentRequestKey;
    if (!keep) {
      deleteRequestKeys.push(row.request_key);
    }
  }

  if (deleteRequestKeys.length > 0) {
    const placeholders = buildInClausePlaceholders(deleteRequestKeys.length);
    await db.execute(`DELETE FROM ghosts WHERE request_key IN (${placeholders})`, deleteRequestKeys);
    await db.execute(`DELETE FROM ghost_fingerprints WHERE request_key IN (${placeholders})`, deleteRequestKeys);
    console.log(`[ghostDatabase] Cleaned ${deleteRequestKeys.length} stale request_key caches`);
  }
}

export async function getCachedFingerprint(requestKey: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ fingerprint: string }[]>(
    "SELECT fingerprint FROM ghost_fingerprints WHERE request_key = ?",
    [requestKey]
  );
  return rows.length > 0 ? rows[0].fingerprint : null;
}

export async function setCachedFingerprint(requestKey: string, fingerprint: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT OR REPLACE INTO ghost_fingerprints (request_key, fingerprint, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
    [requestKey, fingerprint]
  );
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

const GHOST_SELECT_COLUMNS =
  "name, sakura_name, kero_name, craftman, craftmanw, directory_name, path, source, name_lower, sakura_name_lower, kero_name_lower, craftman_lower, craftmanw_lower, directory_name_lower, thumbnail_path, thumbnail_use_self_alpha, thumbnail_kind";

const GHOST_SEARCH_LOWER_COLUMNS = [
  "name_lower",
  "sakura_name_lower",
  "kero_name_lower",
  "craftman_lower",
  "craftmanw_lower",
  "directory_name_lower",
] as const;

const GHOST_SEARCH_WHERE =
  GHOST_SEARCH_LOWER_COLUMNS.map((col) => `${col} LIKE ?`).join(" OR ");

export async function searchGhostsInitialPage(requestKey: string, limit: number): Promise<GhostView[]> {
  const db = await getDb();
  const rows = await db.select<GhostView[]>(
    `SELECT ${GHOST_SELECT_COLUMNS} FROM ghosts WHERE request_key = ? ORDER BY name_lower ASC LIMIT ?`,
    [requestKey, limit]
  );

  console.log(`[ghostDatabase] searchGhostsInitialPage(requestKey=${requestKey}, limit=${limit}) → rows=${rows.length}`);
  return rows;
}

export async function countGhostsByQuery(requestKey: string, query: string): Promise<number> {
  const db = await getDb();
  const normalizedQuery = normalizeForKey(query);

  let countResult: { count: number }[];
  if (normalizedQuery === "") {
    countResult = await db.select<{ count: number }[]>(
      "SELECT COUNT(*) as count FROM ghosts WHERE request_key = ?",
      [requestKey]
    );
  } else {
    const likePattern = `%${normalizedQuery}%`;
    countResult = await db.select<{ count: number }[]>(
      `SELECT COUNT(*) as count FROM ghosts WHERE request_key = ? AND (${GHOST_SEARCH_WHERE})`,
      [requestKey, ...GHOST_SEARCH_LOWER_COLUMNS.map(() => likePattern)]
    );
  }

  return countResult.length > 0 ? countResult[0].count : 0;
}

export async function searchGhosts(requestKey: string, query: string, limit: number, offset: number): Promise<{ ghosts: GhostView[], total: number }> {
  const db = await getDb();

  const normalizedQuery = normalizeForKey(query);
  const likePattern = `%${normalizedQuery}%`;

  const [total, rows] = await Promise.all([
    countGhostsByQuery(requestKey, query),
    db.select<GhostView[]>(
      `SELECT ${GHOST_SELECT_COLUMNS} FROM ghosts WHERE request_key = ? AND (${GHOST_SEARCH_WHERE}) ORDER BY name_lower ASC LIMIT ? OFFSET ?`,
      [requestKey, ...GHOST_SEARCH_LOWER_COLUMNS.map(() => likePattern), limit, offset]
    ),
  ]);

  console.log(`[ghostDatabase] searchGhosts(requestKey=${requestKey}, query="${query}", limit=${limit}, offset=${offset}) → total=${total}`);
  console.log(`[ghostDatabase] Fetched ${rows.length} rows`);
  return { ghosts: rows, total };
}
