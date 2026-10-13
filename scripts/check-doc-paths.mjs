import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

// 検査対象のドキュメント（git pathspec）。/health-check の項目 2/3/5 が参照する範囲
export const DOC_PATHSPECS = [
  "CLAUDE.md",
  "src/CLAUDE.md",
  "src-tauri/CLAUDE.md",
  "e2e/CLAUDE.md",
  ":(glob).claude/skills/*/SKILL.md",
  "SPEC.md",
  ":(glob)docs/*.md",
  "RETROSPECTIVE.md",
];

function gitLsFiles(pathspecs = []) {
  const output = execFileSync("git", ["ls-files", "--", ...pathspecs], { encoding: "utf8" });
  return output.split("\n").filter((line) => line.length > 0);
}

// 実在ファイルの索引。拡張子集合は「ファイル参照らしさ」の判定にも使う
export function buildIndex(trackedFiles) {
  const files = new Set(trackedFiles);
  const byBasename = new Map();
  const extensions = new Set();
  for (const file of trackedFiles) {
    const base = posix.basename(file);
    const list = byBasename.get(base) ?? [];
    list.push(file);
    byBasename.set(base, list);
    const ext = posix.extname(base);
    if (ext) extensions.add(ext);
  }
  return { files, byBasename, extensions };
}

// バックティック内のトークンをファイル参照として扱える形へ正規化する。対象外なら null
// - 空白を含む（コマンド・コード片）、URL、プレースホルダ・glob を含むものは対象外
// - ディレクトリ参照（末尾 `/`）は対象外。ブランチプレフィックス `fix/` 等と区別できないため
// - 末尾の行番号（`foo.ts:12` / `foo.ts:3,22-23`）は落とす
// - 拡張子が追跡ファイルに 1 つも無いもの（i18n キー `list.count`、実行時生成物 `ghosts.db` 等）は対象外
export function toFileRef(token, extensions) {
  if (/\s/.test(token) || token.includes("://")) return null;
  if (/[{}<>*$~()[\]|"'@]/.test(token)) return null;
  const ref = token.replace(/:[\d,-]+$/, "").replace(/^\.\//, "");
  if (ref.endsWith("/")) return null;
  const ext = posix.extname(posix.basename(ref));
  if (!ext || !extensions.has(ext)) return null;
  return ref;
}

// "ok"（完全一致 or 短縮参照）/ "mismatch"（basename は実在するがパスが食い違う）/ "missing"
export function classify(ref, index) {
  if (index.files.has(ref)) return { status: "ok" };
  const candidates = index.byBasename.get(posix.basename(ref));
  if (!candidates) return { status: "missing" };
  if (candidates.some((file) => file.endsWith(`/${ref}`))) return { status: "ok" };
  return { status: "mismatch", candidates };
}

// フェンスコードブロックの外にあるインラインコードを行番号つきで抽出する
export function extractInlineCode(markdown) {
  const tokens = [];
  let fence = null;
  markdown.split(/\r?\n/).forEach((line, i) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1];
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      return;
    }
    if (fence !== null) return;
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      tokens.push({ line: i + 1, token: match[1] });
    }
  });
  return tokens;
}

export function checkDocs(docs, index) {
  const findings = [];
  let checked = 0;
  for (const { path, content } of docs) {
    for (const { line, token } of extractInlineCode(content)) {
      const ref = toFileRef(token, index.extensions);
      if (ref === null) continue;
      checked += 1;
      const result = classify(ref, index);
      if (result.status !== "ok") findings.push({ doc: path, line, ref, ...result });
    }
  }
  return { findings, checked };
}

function runCli() {
  const index = buildIndex(gitLsFiles());
  const docs = gitLsFiles(DOC_PATHSPECS).map((path) => ({ path, content: readFileSync(path, "utf8") }));
  const { findings, checked } = checkDocs(docs, index);

  const missing = findings.filter((f) => f.status === "missing");
  const mismatch = findings.filter((f) => f.status === "mismatch");
  for (const f of missing) {
    console.log(`MISSING  ${f.doc}:${f.line}: ${f.ref}`);
  }
  for (const f of mismatch) {
    console.log(`MISMATCH ${f.doc}:${f.line}: ${f.ref} -> 実在: ${f.candidates.join(", ")}`);
  }
  console.log(
    `参照パス検査: ドキュメント ${docs.length} 件・参照 ${checked} 件 / MISSING ${missing.length} 件 / MISMATCH ${mismatch.length} 件`,
  );
  if (findings.length > 0) process.exit(1);
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  runCli();
}
