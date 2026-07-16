import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { GhostView, SortOrder } from "../types";
import { measureSearch, reportDbSize } from "./dbMonitor";

let dbInitPromise: Promise<Database> | null = null;

const VACUUM_FREE_RATIO = 0.25;
const VACUUM_FREE_BYTES = 1_048_576;

async function vacuumIfNeeded(db: Database): Promise<void> {
  try {
    const pageCountRows = await db.select<{ page_count: number }[]>("PRAGMA page_count");
    const pageCount = pageCountRows[0]?.page_count ?? 0;
    if (pageCount === 0) return;

    const freelistRows = await db.select<{ freelist_count: number }[]>("PRAGMA freelist_count");
    const freelistCount = freelistRows[0]?.freelist_count ?? 0;
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
  } catch (e) {
    console.warn("[ghostDatabase] VACUUM をスキップしました", e);
  }
}

async function loadDb(): Promise<Database> {
  const db = await Database.load("sqlite:ghosts.db");
  await db.execute("PRAGMA journal_mode=WAL");
  await db.execute("PRAGMA busy_timeout=5000");
  await db.execute("PRAGMA journal_size_limit=4194304");
  // 0x10002: 全テーブル対象（0x10000）+ ANALYZE 実行（0x02）。
  // 長命な接続では接続直後にクエリ履歴がないため、全テーブル対象が必要。
  await db.execute("PRAGMA optimize=0x10002");
  await vacuumIfNeeded(db);
  return db;
}

async function initializeDb(): Promise<Database> {
  try {
    const db = await loadDb();
    console.log("[ghostDatabase] Database loaded successfully");
    void reportDbSize(db, "startup").catch(() => {});
    return db;
  } catch (e) {
    // リカバリ不能: Promise をリセットして次回再試行可能にする。
    // 旧「マイグレーション競合 → reset」の回復パスは、使い捨てスキーマ化（Rust 側
    // ensure_cache_schema が起動時に自動リビルド）でエラークラスごと消滅した。
    dbInitPromise = null;
    throw e;
  }
}

export function getDb(): Promise<Database> {
  if (!dbInitPromise) {
    console.log("[ghostDatabase] Loading SQLite database...");
    dbInitPromise = initializeDb();
  }
  return dbInitPromise;
}

/// DB 初期化を早期にキックオフする（fire-and-forget）。
/// React のレンダリング前に呼ぶことで、最初の DB アクセスを高速化する。
export function warmUpDb(): void {
  void getDb().catch((e) => console.warn("[ghostDatabase] warmup に失敗しました", e));
}

export function normalizeForKey(value: string): string {
  return value.normalize("NFKC").toLowerCase();
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
    // ghost_scan_entries は走査差分の前回状態（ghosts と運命共有の揮発キャッシュ）。
    // 同一 request_key で一括削除し、古い世代の scan_entries が残留しないようにする。
    await db.execute(`DELETE FROM ghost_scan_entries WHERE request_key IN (${placeholders})`, deleteRequestKeys);
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

export async function hasGhosts(requestKey: string): Promise<boolean> {
  const db = await getDb();
  const countResult = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM ghosts WHERE request_key = ?",
    [requestKey]
  );
  const total = countResult.length > 0 ? countResult[0].count : 0;
  return total > 0;
}

// SELECT 対象列の単一権威。satisfies が GhostView に無い列名（typo・削除漏れ）を弾く。
// 列を増減するときは GhostView（src/types/index.ts）と
// src/test/fixtures/ghost-view-columns.json も更新する（Rust 側テストがスキーマと照合）。
export const GHOST_VIEW_COLUMNS = [
  "name",
  "sakura_name",
  "kero_name",
  "craftman",
  "craftmanw",
  "directory_name",
  "path",
  "source",
  "name_lower",
  "sakura_name_lower",
  "kero_name_lower",
  "craftman_lower",
  "craftmanw_lower",
  "directory_name_lower",
  "thumbnail_path",
  "thumbnail_use_self_alpha",
  "thumbnail_kind",
  "ghost_identity_key",
] as const satisfies readonly (keyof GhostView)[];

// GhostView のフィールドで GHOST_VIEW_COLUMNS に列挙されていないもの。
// 列挙漏れがあると never でなくなり、下の型注釈が never に解決されて代入が型エラーになる。
type MissingGhostViewColumns = Exclude<keyof GhostView, (typeof GHOST_VIEW_COLUMNS)[number]>;

export const GHOST_SEARCH_LOWER_COLUMNS = [
  "name_lower",
  "sakura_name_lower",
  "kero_name_lower",
  "craftman_lower",
  "craftmanw_lower",
  "directory_name_lower",
] as const;

const GHOST_SEARCH_WHERE =
  GHOST_SEARCH_LOWER_COLUMNS.map((col) => `${col} LIKE ?`).join(" OR ");

const GHOST_SELECT_COLUMNS_PREFIXED: [MissingGhostViewColumns] extends [never] ? string : never =
  GHOST_VIEW_COLUMNS.map((c) => `g.${c}`).join(", ");

// random ソート用のセッションシード。ORDER BY 式を固定することで、
// 仮想スクロールの offset ページングとバッファマージに対して順序が安定する。
// 素数の剰余で id を攪拌する。剰余の衝突は第 2 キー g.id で安定化する。
const RANDOM_SORT_MODULUS = 1000003;

function newRandomSortSeed(): number {
  return Math.floor(Math.random() * (RANDOM_SORT_MODULUS - 1)) + 1;
}

let randomSortSeed = newRandomSortSeed();

/// random ソートの並びを引き直す（ソートで「ランダム」を選択したときに呼ぶ）
export function reseedRandomSort(): void {
  randomSortSeed = newRandomSortSeed();
}

// SELECT の ORDER BY 式を返す。recent/frequency は ghosts の非正規化集計列
// （last_launched / launch_count）で並べる。起動履歴は user-data.db（Rust 専有）に
// 分離され、集計列は record_launch とスキャン時バックフィルで維持される。
export function buildOrderBy(sortOrder: SortOrder): string {
  switch (sortOrder) {
    case "random":
      return `(g.id * ${randomSortSeed}) % ${RANDOM_SORT_MODULUS}, g.id`;
    case "recent":
      return "g.last_launched DESC NULLS LAST, g.name_lower ASC";
    case "frequency":
      return "g.launch_count DESC, g.name_lower ASC";
    default:
      return "g.name_lower ASC";
  }
}

export async function searchGhostsInitialPage(requestKey: string, limit: number, sortOrder: SortOrder = "name"): Promise<GhostView[]> {
  return measureSearch("searchGhostsInitialPage", async () => {
    const db = await getDb();
    const orderBy = buildOrderBy(sortOrder);
    const rows = await db.select<GhostView[]>(
      `SELECT ${GHOST_SELECT_COLUMNS_PREFIXED} FROM ghosts g WHERE g.request_key = ? ORDER BY ${orderBy} LIMIT ?`,
      [requestKey, limit]
    );

    console.log(`[ghostDatabase] searchGhostsInitialPage(requestKey=${requestKey}, limit=${limit}, sort=${sortOrder}) → rows=${rows.length}`);
    return rows;
  });
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

export async function searchGhosts(requestKey: string, query: string, limit: number, offset: number, sortOrder: SortOrder = "name"): Promise<{ ghosts: GhostView[], total: number }> {
  return measureSearch("searchGhosts", async () => {
    const db = await getDb();

    const normalizedQuery = normalizeForKey(query);
    const likePattern = `%${normalizedQuery}%`;
    const orderBy = buildOrderBy(sortOrder);
    const searchWhere = GHOST_SEARCH_LOWER_COLUMNS.map((col) => `g.${col} LIKE ?`).join(" OR ");

    const [total, rows] = await Promise.all([
      countGhostsByQuery(requestKey, query),
      db.select<GhostView[]>(
        `SELECT ${GHOST_SELECT_COLUMNS_PREFIXED} FROM ghosts g WHERE g.request_key = ? AND (${searchWhere}) ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        [requestKey, ...GHOST_SEARCH_LOWER_COLUMNS.map(() => likePattern), limit, offset]
      ),
    ]);

    console.log(`[ghostDatabase] searchGhosts(requestKey=${requestKey}, query="${query}", limit=${limit}, offset=${offset}, sort=${sortOrder}) → total=${total}`);
    console.log(`[ghostDatabase] Fetched ${rows.length} rows`);
    return { ghosts: rows, total };
  });
}

export async function recordLaunch(ghostIdentityKey: string): Promise<void> {
  await invoke("record_launch", { ghostIdentityKey });
}

export async function getRandomGhost(requestKey: string): Promise<GhostView | null> {
  const db = await getDb();
  const rows = await db.select<GhostView[]>(
    `SELECT ${GHOST_SELECT_COLUMNS_PREFIXED} FROM ghosts g WHERE g.request_key = ? ORDER BY RANDOM() LIMIT 1`,
    [requestKey]
  );
  return rows.length > 0 ? rows[0] : null;
}
