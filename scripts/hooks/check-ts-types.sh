#!/bin/bash
# PostToolUse hook: .ts/.tsx ファイル編集後に型チェックを実行
# Edit/Write の file_path が .ts or .tsx で終わる場合のみ tsc を走らせる
# --incremental のキャッシュは node_modules/.cache 配下に置き、コミット対象外にする

case "$TOOL_INPUT" in
  *'.ts"'*|*'.tsx"'*)
    # 依存未インストール時（fresh clone 直後など）はチェック不能なのでスキップ
    [ -f node_modules/typescript/bin/tsc ] || exit 0
    mkdir -p node_modules/.cache
    output=$(node node_modules/typescript/bin/tsc --noEmit --pretty --incremental \
      --tsBuildInfoFile node_modules/.cache/hook-typecheck.tsbuildinfo 2>&1)
    exit_code=$?
    if [ $exit_code -ne 0 ]; then
      echo "$output" | tail -10
    fi
    ;;
esac
