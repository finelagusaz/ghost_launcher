#!/bin/bash
# PreToolUse hook (Edit): cache_schema.rs の CACHE_SCHEMA 編集時に警告する（非ブロック）。
# CACHE_SCHEMA の変更は次回起動で全ユーザーのキャッシュを破棄しフルスキャンで再投入する。
# 意図した変更なら続行してよい。tool 入力は stdin の JSON で渡る。$TOOL_INPUT は存在しない。

input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
case "$file_path" in
  *cache_schema.rs) ;;
  *) exit 0 ;;
esac

if echo "$input" | grep -qiE 'ALTER TABLE|CREATE TABLE|CREATE INDEX|DROP TABLE|DROP INDEX'; then
  echo "CACHE_SCHEMA を編集しようとしています。変更は次回起動で全ユーザーのキャッシュ破棄＋フルスキャン再投入を伴います（src-tauri/CLAUDE.md「使い捨てスキーマ」参照）。意図した変更なら続行してください。"
fi
exit 0
