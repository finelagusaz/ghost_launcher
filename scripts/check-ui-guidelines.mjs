import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

function read(relativePath) {
  const fullPath = resolve(process.cwd(), relativePath);
  try {
    return readFileSync(fullPath, "utf8");
  } catch (error) {
    throw new Error(`ファイルを読み込めません: ${relativePath} (${String(error)})`);
  }
}

const SOURCE_EXTENSIONS = [".ts", ".tsx"];

// dir 内の全 .ts/.tsx ソースを結合して返す
function readDir(relativeDir) {
  const fullPath = resolve(process.cwd(), relativeDir);
  const entries = readdirSync(fullPath, { recursive: true });
  return entries
    .filter((entry) => SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext)))
    .map((entry) => readFileSync(join(fullPath, entry), "utf8"))
    .join("\n");
}

export const checks = [
  {
    id: "searchbox-labeled",
    file: "src/components/SearchBox.tsx",
    message: "検索入力には Field コンポーネントの label プロパティが必要です。",
    // 文字列リテラル・t() どちらでも label= があれば OK
    test: (source) => /<Field\b[^>]*\blabel\s*=/.test(source),
  },
  {
    id: "settings-delete-aria-label",
    file: "src/components/SettingsPanel.tsx",
    message: "削除ボタンには対象フォルダ名を含む aria-label が必要です。",
    // テンプレートリテラル（`...${folder}...`）または t() に folder を渡す形式を許可
    test: (source) =>
      /aria-label\s*=\s*\{(?:\s*`追加フォルダを削除\s*:\s*\$\{folder\}`\s*|t\([^)]*\{[^}]*\bfolder\b[^}]*\}[^)]*\))\}/.test(source),
  },
  {
    id: "ghostlist-alert-role",
    file: "src/components/GhostList.tsx",
    message: "一覧エラー表示には role=\"alert\" が必要です。",
    test: (source) => /role="alert"/.test(source),
  },
  {
    id: "ghostcard-alert-role",
    file: "src/components/GhostCard.tsx",
    message: "起動エラー表示には role=\"alert\" が必要です。",
    test: (source) => /role="alert"/.test(source),
  },
  {
    id: "ghostlist-no-window-inner-height",
    file: "src/components/GhostList.tsx",
    message: "仮想化の計算は window.innerHeight 依存を避けてください。",
    test: (source) => !/window\.innerHeight/.test(source),
  },
  {
    id: "scan-error-actionable",
    // 文言の所在（各ロケールの error.scanFailed）に絞る。再操作の手段は再読込ボタンなので、
    // ボタン名を直書きせず $t(header.refresh) で参照させる（ボタン名を変えても文言がずれない）
    files: () => listLocaleFiles(),
    message: "スキャン失敗の文言（error.scanFailed）は $t(header.refresh) で再読込ボタンを案内してください。",
    test: (source) => {
      const value = JSON.parse(source)["error.scanFailed"];
      return typeof value === "string" && value.includes("$t(header.refresh)");
    },
  },
];

const LOCALES_DIR = "src/locales";

// 同梱ロケールの全ファイル。ロケールを足したら自動で検査対象に入る
function listLocaleFiles() {
  return readdirSync(resolve(process.cwd(), LOCALES_DIR))
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => `${LOCALES_DIR}/${entry}`);
}

export function runChecks() {
  const failures = [];

  for (const check of checks) {
    let targets;
    try {
      targets = check.dir ? [check.dir] : check.files ? check.files() : [check.file];
    } catch (error) {
      failures.push(`[${check.id}] ${String(error)}`);
      continue;
    }
    if (targets.length === 0) {
      // 対象 0 件で素通りすると、検査が消えたことに気づけない
      failures.push(`[${check.id}] 検査対象のファイルがありません`);
      continue;
    }

    for (const target of targets) {
      let passed;
      try {
        passed = check.test(check.dir ? readDir(target) : read(target));
      } catch (error) {
        failures.push(`[${check.id}] ${target}: ${String(error)}`);
        continue;
      }
      if (!passed) {
        failures.push(`[${check.id}] ${target}: ${check.message}`);
      }
    }
  }

  return failures;
}

function runCli() {
  const failures = runChecks();

  if (failures.length > 0) {
    console.error("UI ガイドラインチェックに失敗しました。");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log(`UI ガイドラインチェック: ${checks.length} 件すべて成功`);
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  runCli();
}
