import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { GhostView, SortOrder } from "../types";
import { measureSearch, reportDbSize } from "./dbMonitor";

let dbInitPromise: Promise<Database> | null = null;

/// JS の接続は読み取り専用で開く。書き込みは全て IPC 経由で Rust の DB アクターが行う。
/// webview には sql の execute 権限を渡していないが、select も任意の文を流せるため、
/// 書き込みを止めるのは接続の mode=ro である。
/// busy_timeout は sqlx-sqlite が接続確立ごとに既定 5 秒を当てるので設定しない。
/// journal_mode=WAL はファイルの属性で、Rust 側が設定済み。
async function loadDb(): Promise<Database> {
  return Database.load("sqlite:ghosts.db?mode=ro");
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

/// 古い request_key 世代のキャッシュ削除。実体は Rust の CleanupCaches ジョブ
/// （ポリシー: 世代 5・TTL 30 日は Rust 側 const）。戻り値は削除世代数。
export async function cleanupOldGhostCaches(currentRequestKey: string): Promise<void> {
  const deleted = await invoke<number>("cleanup_ghost_caches", { currentRequestKey });
  if (deleted > 0) {
    console.log(`[ghostDatabase] Cleaned ${deleted} stale request_key caches`);
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
  // EXISTS は最初の 1 行で観測が止まる（COUNT(*) はパーティション全数を数える）
  const rows = await db.select<{ has: number }[]>(
    "SELECT EXISTS(SELECT 1 FROM ghosts WHERE request_key = ?) as has",
    [requestKey]
  );
  return rows.length > 0 && rows[0].has === 1;
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

// 検索述語。search_text は CACHE_SCHEMA（src-tauri/src/cache_schema.rs）の生成列で、
// 検索 6 列（_lower 群）の \x1f 連結。導出式はスキーマ側が単一権威。
// instr はリテラル一致のため LIKE と違い %/_ のワイルドカード解釈が起きない。
// export は言語間パリティテスト（searchSqlShapes.parity.test.ts・共有 fixture 経由で
// bench_support::SEARCH_WHERE_PREFIXED と同期）のため
export const GHOST_SEARCH_WHERE_PREFIXED = "instr(g.search_text, ?) > 0";
// 非前置き版（countGhostsByQuery 用）は前置き版から導出し、両変体の乖離を防ぐ
const GHOST_SEARCH_WHERE = GHOST_SEARCH_WHERE_PREFIXED.replace("g.", "");

// 検索語つきの件数。プランナは件数だけの集計に最小の UNIQUE index を選び、行ごとに本体を
// 読んで search_text を評価するため、search_text 同乗 index を INDEXED BY で明示して
// index 上で述語を完結させる（10 万体で約 4 倍速い）。index の実在・search_text の所持・
// 選ばれることは Rust 側テストが共有 fixture（search-sql-shapes.json）経由でスキーマと照合する
export const GHOST_SEARCH_COUNT_INDEX = "idx_ghosts_request_key_name_search";
export const GHOST_SEARCH_COUNT_SQL =
  `SELECT COUNT(*) as count FROM ghosts INDEXED BY ${GHOST_SEARCH_COUNT_INDEX} WHERE request_key = ? AND (${GHOST_SEARCH_WHERE})`;

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

// 起動の記録で並び順が変わるソートか（ghosts の集計列 last_launched / launch_count で並べるか）。
// buildOrderBy と同じ場所に置き、ソートを足すときに両方を見直せるようにする
export function sortDependsOnLaunchStats(sortOrder: SortOrder): boolean {
  return sortOrder === "recent" || sortOrder === "frequency";
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
    countResult = await db.select<{ count: number }[]>(GHOST_SEARCH_COUNT_SQL, [requestKey, normalizedQuery]);
  }

  return countResult.length > 0 ? countResult[0].count : 0;
}

// ページフェッチ（SELECT のみ）。総件数は返さない: total が変わるのはリセット時
// （requestKey/query/sort/epoch 変更）だけなので、COUNT の発行は useSearch が
// リセット時に 1 回だけ countGhostsByQuery で行う（スクロールの各ページで併走させない）。
export async function searchGhosts(requestKey: string, query: string, limit: number, offset: number, sortOrder: SortOrder = "name"): Promise<GhostView[]> {
  return measureSearch("searchGhosts", async () => {
    const db = await getDb();

    const normalizedQuery = normalizeForKey(query);
    const orderBy = buildOrderBy(sortOrder);

    let rows: GhostView[];
    if (normalizedQuery === "") {
      // 空クエリに検索述語の行ごと評価をさせない
      rows = await db.select<GhostView[]>(
        `SELECT ${GHOST_SELECT_COLUMNS_PREFIXED} FROM ghosts g WHERE g.request_key = ? ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        [requestKey, limit, offset]
      );
    } else {
      rows = await db.select<GhostView[]>(
        `SELECT ${GHOST_SELECT_COLUMNS_PREFIXED} FROM ghosts g WHERE g.request_key = ? AND (${GHOST_SEARCH_WHERE_PREFIXED}) ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        [requestKey, normalizedQuery, limit, offset]
      );
    }

    console.log(`[ghostDatabase] searchGhosts(requestKey=${requestKey}, query="${query}", limit=${limit}, offset=${offset}, sort=${sortOrder}) → rows=${rows.length}`);
    return rows;
  });
}

export async function recordLaunch(ghostIdentityKey: string): Promise<void> {
  await invoke("record_launch", { ghostIdentityKey });
}

export async function getRandomGhost(requestKey: string): Promise<GhostView | null> {
  const db = await getDb();
  // ORDER BY RANDOM() はパーティション全走査＋全行ソートになるため、
  // COUNT（index-only scan）＋乱数 OFFSET の単発取得で 1 体を選ぶ。
  // ORDER BY なしの LIMIT 1 は行順が不定だが、無作為抽出には順序の権威が不要
  const countResult = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM ghosts WHERE request_key = ?",
    [requestKey]
  );
  const total = countResult.length > 0 ? countResult[0].count : 0;
  if (total === 0) {
    return null;
  }
  const randomOffset = Math.floor(Math.random() * total);
  const rows = await db.select<GhostView[]>(
    `SELECT ${GHOST_SELECT_COLUMNS_PREFIXED} FROM ghosts g WHERE g.request_key = ? LIMIT 1 OFFSET ?`,
    [requestKey, randomOffset]
  );
  return rows.length > 0 ? rows[0] : null;
}
