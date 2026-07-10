#!/bin/bash
# PostToolUse hook (Edit|Write): .ts/.tsx 編集後に tsc --noEmit で型チェックする。
# tool 入力は stdin の JSON で渡る（.tool_input.file_path）。$TOOL_INPUT は存在しない。
# --incremental のキャッシュは node_modules/.cache 配下に置き、コミット対象外にする

file_path=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
case "$file_path" in
  *.ts | *.tsx) ;;
  *) exit 0 ;;
esac

# tsc は tsconfig.json をルートから解決するため、プロジェクトルートへ移動する。
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# 依存未インストール時（fresh clone 直後など）はチェック不能なのでスキップ
[ -f node_modules/typescript/bin/tsc ] || exit 0
mkdir -p node_modules/.cache
if ! output=$(node node_modules/typescript/bin/tsc --noEmit --pretty --incremental \
  --tsBuildInfoFile node_modules/.cache/hook-typecheck.tsbuildinfo 2>&1); then
  echo "$output" | tail -10
fi
