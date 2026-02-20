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
    message: "検索入力に明示ラベルが必要です (`Field label=\"ゴースト検索\"`)。",
    test: (source) => /<Field\b[^>]*\blabel\s*=\s*"ゴースト検索"[^>]*>/.test(source),
  },
  {
    id: "settings-delete-aria-label",
    file: "src/components/SettingsPanel.tsx",
    message: "削除ボタンには対象フォルダ名を含む aria-label が必要です。",
    test: (source) => /aria-label\s*=\s*\{\s*`追加フォルダを削除\s*:\s*\$\{folder\}`\s*\}/.test(source),
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
    dir: "src",
    message: "スキャン失敗時は再操作が分かる文言を含めてください。",
    test: (source) => /再読込/.test(source),
  },
];

export function runChecks() {
  const failures = [];

  for (const check of checks) {
    const target = check.dir ?? check.file;
    let source = "";
    try {
      source = check.dir ? readDir(check.dir) : read(check.file);
    } catch (error) {
      failures.push(`[${check.id}] ${String(error)}`);
      continue;
    }

    if (!check.test(source)) {
      failures.push(`[${check.id}] ${target}: ${check.message}`);
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
