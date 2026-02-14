import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function read(relativePath) {
  const fullPath = resolve(process.cwd(), relativePath);
  try {
    return readFileSync(fullPath, "utf8");
  } catch (error) {
    throw new Error(`ファイルを読み込めません: ${relativePath} (${String(error)})`);
  }
}

const checks = [
  {
    id: "searchbox-labeled",
    file: "src/components/SearchBox.tsx",
    message: "検索入力に明示ラベルが必要です (`Field label=\"ゴースト検索\"`)。",
    test: (source) => /<Field\b[\s\S]*?label="ゴースト検索"/.test(source),
  },
  {
    id: "settings-delete-aria-label",
    file: "src/components/SettingsPanel.tsx",
    message: "削除ボタンには対象フォルダ名を含む aria-label が必要です。",
    test: (source) => /aria-label=\{[^}]*追加フォルダを削除/.test(source),
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
    file: "src/hooks/useGhosts.ts",
    message: "スキャン失敗時は再操作が分かる文言を含めてください。",
    test: (source) => /再読込/.test(source),
  },
];

const failures = [];

for (const check of checks) {
  let source = "";
  try {
    source = read(check.file);
  } catch (error) {
    failures.push(`[${check.id}] ${String(error)}`);
    continue;
  }

  if (!check.test(source)) {
    failures.push(`[${check.id}] ${check.file}: ${check.message}`);
  }
}

if (failures.length > 0) {
  console.error("UI ガイドラインチェックに失敗しました。");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`UI ガイドラインチェック: ${checks.length} 件すべて成功`);
