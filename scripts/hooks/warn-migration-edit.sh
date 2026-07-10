#!/bin/bash
# PreToolUse hook (Edit): lib.rs のマイグレーション SQL 編集時に警告する（非ブロック）。
# 既存マイグレーションの SQL を変更するとチェックサム不一致で起動クラッシュする。
# 新規マイグレーション追加は安全。tool 入力は stdin の JSON で渡る。$TOOL_INPUT は存在しない。

input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
case "$file_path" in
  *lib.rs) ;;
  *) exit 0 ;;
esac

# old_string / new_string の双方を含む tool_input 全体を対象に SQL キーワードを探す。
if echo "$input" | grep -qiE 'ALTER TABLE|CREATE TABLE|CREATE INDEX|DROP TABLE|DROP INDEX'; then
  echo "lib.rs のマイグレーション SQL を編集しようとしています。既存マイグレーションの変更はチェックサム不一致で起動クラッシュします（src-tauri/CLAUDE.md 参照）。新規マイグレーション追加のみ安全です。"
fi
exit 0
