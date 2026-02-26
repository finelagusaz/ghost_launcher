import Database from "@tauri-apps/plugin-sql";
import { Ghost, GhostView } from "../types";

let dbInstance: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!dbInstance) {
    console.log("[ghostDatabase] Loading SQLite database...");
    dbInstance = await Database.load("sqlite:ghosts.db");
    console.log("[ghostDatabase] Database loaded successfully");
  }
  return dbInstance;
}

export async function clearGhosts(): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM ghosts");
  console.log("[ghostDatabase] Cleared ghosts table");
}

export async function insertGhostsBatch(ghosts: Ghost[]): Promise<void> {
  if (ghosts.length === 0) return;
  const db = await getDb();

  // SQLite の SQLITE_MAX_VARIABLE_NUMBER = 999。6列×100行=600で安全圏。
  const chunkSize = 100;
  let inserted = 0;
  for (let i = 0; i < ghosts.length; i += chunkSize) {
    const chunk = ghosts.slice(i, i + chunkSize);

    let sql = "INSERT INTO ghosts (name, directory_name, path, source, name_lower, directory_name_lower) VALUES ";
    const placeholders: string[] = [];
    const params: string[] = [];

    for (const ghost of chunk) {
      placeholders.push("(?, ?, ?, ?, ?, ?)");
      params.push(ghost.name);
      params.push(ghost.directory_name);
      params.push(ghost.path);
      params.push(ghost.source);
      params.push(ghost.name.toLowerCase());
      params.push(ghost.directory_name.toLowerCase());
    }

    sql += placeholders.join(", ");
    await db.execute(sql, params);
    inserted += chunk.length;
  }
  console.log(`[ghostDatabase] Inserted ${inserted} ghosts into SQLite`);
}

export async function searchGhosts(query: string, limit: number, offset: number): Promise<{ ghosts: GhostView[], total: number }> {
  const db = await getDb();

  const likePattern = `%${query.toLowerCase()}%`;

  // SQLite では ? プレースホルダを使う ($1/$2 は PostgreSQL 構文)
  const countResult = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM ghosts WHERE name_lower LIKE ? OR directory_name_lower LIKE ?",
    [likePattern, likePattern]
  );

  const total = countResult.length > 0 ? countResult[0].count : 0;
  console.log(`[ghostDatabase] searchGhosts("${query}", limit=${limit}, offset=${offset}) → total=${total}`);

  const rows = await db.select<GhostView[]>(
    "SELECT name, directory_name, path, source, name_lower, directory_name_lower FROM ghosts WHERE name_lower LIKE ? OR directory_name_lower LIKE ? ORDER BY name_lower ASC LIMIT ? OFFSET ?",
    [likePattern, likePattern, limit, offset]
  );

  console.log(`[ghostDatabase] Fetched ${rows.length} rows`);
  return { ghosts: rows, total };
}

