#!/bin/bash
# PostToolUse hook: .rs ファイル編集後に cargo clippy を実行
# Edit/Write の file_path が .rs で終わる場合のみ clippy を走らせる

case "$TOOL_INPUT" in
  *'.rs"'*)
    output=$(cargo clippy --manifest-path src-tauri/Cargo.toml --quiet 2>&1)
    exit_code=$?
    if [ $exit_code -ne 0 ]; then
      echo "$output" | tail -15
    fi
    ;;
esac
