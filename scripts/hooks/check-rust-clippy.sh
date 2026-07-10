#!/bin/bash
# PostToolUse hook (Edit|Write): .rs 編集後に cargo clippy を実行する。
# tool 入力は stdin の JSON で渡る（.tool_input.file_path）。$TOOL_INPUT は存在しない。

file_path=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
case "$file_path" in
  *.rs) ;;
  *) exit 0 ;;
esac

# --manifest-path が相対指定のため、プロジェクトルートへ移動してから走らせる。
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
if ! output=$(cargo clippy --manifest-path src-tauri/Cargo.toml --quiet 2>&1); then
  echo "$output" | tail -15
fi
