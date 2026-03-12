#!/bin/bash
# PreToolUse hook: lib.rs のマイグレーション SQL 編集時に警告（非ブロック）
# 既存マイグレーションの SQL を変更するとチェックサム不一致で起動クラッシュする。
# 新規マイグレーション追加は安全。

case "$TOOL_INPUT" in
  *'lib.rs"'*)
    if echo "$TOOL_INPUT" | grep -qiE 'ALTER TABLE|CREATE TABLE|CREATE INDEX|DROP TABLE|DROP INDEX'; then
      echo "lib.rs のマイグレーション SQL を編集しようとしています。既存マイグレーションの変更はチェックサム不一致で起動クラッシュします（src-tauri/CLAUDE.md 参照）。新規マイグレーション追加のみ安全です。"
    fi
    ;;
esac
