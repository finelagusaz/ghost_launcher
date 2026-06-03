#!/bin/bash
# PostToolUse hook (Edit|Write): .ts/.tsx 編集後に tsc --noEmit で型チェックする。
# tool 入力は stdin の JSON で渡る（.tool_input.file_path）。$TOOL_INPUT は存在しない。

file_path=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
case "$file_path" in
  *.ts | *.tsx) ;;
  *) exit 0 ;;
esac

# tsc は tsconfig.json をルートから解決するため、プロジェクトルートへ移動する。
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
if ! output=$(npx tsc --noEmit --pretty 2>&1); then
  echo "$output" | tail -10
fi
