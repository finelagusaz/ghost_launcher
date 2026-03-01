import Database from "@tauri-apps/plugin-sql";
import { Ghost, GhostView } from "../types";

let dbInstance: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!dbInstance) {
    console.log("[ghostDatabase] Loading SQLite database...");
    const db = await Database.load("sqlite:ghosts.db");
    await db.execute("PRAGMA journal_mode=WAL");
    await db.execute("PRAGMA busy_timeout=5000");
    dbInstance = db;
    console.log("[ghostDatabase] Database loaded successfully");
  }
  return dbInstance;
}

// migration が適用されなかった場合の防衛線。ghostCatalogService の先頭で呼び出す。
// craftman カラムが欠落していれば ALTER TABLE で追加し、キャッシュをリセットする。
// hasGhosts() が false を返すようになるため、次のスキャンで自動的に再構築される。
// セッション内で1回だけ実行する（PRAGMA table_info の繰り返し呼び出しを防ぐ）。
let schemaRepaired = false;
export async function repairGhostDbSchema(): Promise<void> {
  if (schemaRepaired) return;
  schemaRepaired = true;
  const db = await getDb();
  const columns = await db.select<{ name: string }[]>("PRAGMA table_info(ghosts)");
  if (columns.length === 0) return; // テーブル未作成（migration が処理する）
  const hasCraftman = columns.some((col) => col.name === "craftman");
  if (!hasCraftman) {
    console.warn("[ghostDatabase] craftman カラムが欠落しています。スキーマを修復します...");
    await db.execute("ALTER TABLE ghosts ADD COLUMN craftman TEXT NOT NULL DEFAULT ''");
    await db.execute("DELETE FROM ghosts");
    console.warn("[ghostDatabase] スキーマ修復完了。ゴーストキャッシュをリセットしました");
  }
  const hasThumbnailPath = columns.some((col) => col.name === "thumbnail_path");
  const hasThumbnailSelfAlpha = columns.some((col) => col.name === "thumbnail_use_self_alpha");
  if (!hasThumbnailPath || !hasThumbnailSelfAlpha) {
    console.warn("[ghostDatabase] thumbnail カラムが欠落しています。スキーマを修復します...");
    if (!hasThumbnailPath) {
      await db.execute("ALTER TABLE ghosts ADD COLUMN thumbnail_path TEXT NOT NULL DEFAULT ''");
    }
    if (!hasThumbnailSelfAlpha) {
      await db.execute("ALTER TABLE ghosts ADD COLUMN thumbnail_use_self_alpha INTEGER NOT NULL DEFAULT 0");
    }
    await db.execute("DELETE FROM ghosts");
    console.warn("[ghostDatabase] スキーマ修復完了。ゴーストキャッシュをリセットしました");
  }
  const hasThumbnailKind = columns.some((col) => col.name === "thumbnail_kind");
  if (!hasThumbnailKind) {
    console.warn("[ghostDatabase] thumbnail_kind カラムが欠落しています。スキーマを修復します...");
    await db.execute("ALTER TABLE ghosts ADD COLUMN thumbnail_kind TEXT NOT NULL DEFAULT ''");
    await db.execute("DELETE FROM ghosts");
    console.warn("[ghostDatabase] スキーマ修復完了。ゴーストキャッシュをリセットしました");
  }
}

export async function clearGhostsByRequestKey(requestKey: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM ghosts WHERE request_key = ?", [requestKey]);
  console.log(`[ghostDatabase] Cleared ghosts table for requestKey=${requestKey}`);
}

export async function insertGhostsBatch(requestKey: string, ghosts: Ghost[]): Promise<void> {
  if (ghosts.length === 0) return;
  const db = await getDb();

  // SQLite の SQLITE_MAX_VARIABLE_NUMBER = 999。11列×90行=990で安全圏。
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
    "SELECT name, craftman, directory_name, path, source, name_lower, directory_name_lower, thumbnail_path, thumbnail_use_self_alpha, thumbnail_kind FROM ghosts WHERE request_key = ? AND (name_lower LIKE ? OR directory_name_lower LIKE ?) ORDER BY name_lower ASC LIMIT ? OFFSET ?",
    [requestKey, likePattern, likePattern, limit, offset]
  );

  console.log(`[ghostDatabase] Fetched ${rows.length} rows`);
  return { ghosts: rows, total };
}
