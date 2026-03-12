#!/bin/bash
# PostToolUse hook: .ts/.tsx ファイル編集後に型チェックを実行
# Edit/Write の file_path が .ts or .tsx で終わる場合のみ tsc を走らせる

case "$TOOL_INPUT" in
  *'.ts"'*|*'.tsx"'*)
    output=$(npx tsc --noEmit --pretty 2>&1)
    exit_code=$?
    if [ $exit_code -ne 0 ]; then
      echo "$output" | tail -10
    fi
    ;;
esac
