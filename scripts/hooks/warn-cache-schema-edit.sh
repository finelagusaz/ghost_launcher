#!/bin/bash
# PreToolUse hook (Edit|Write): cache_schema.rs の CACHE_SCHEMA 編集時に警告する（非ブロック）。
# CACHE_SCHEMA の変更は次回起動で全ユーザーのキャッシュを破棄しフルスキャンで再投入する。
# 意図した変更なら続行してよい。DDL の有無は tool 入力全体（Edit の new_string・Write の content）で見る。

. "$(dirname "$0")/_lib.sh"
hook_read_input

case "$HOOK_FILE_PATH" in
  *cache_schema.rs) ;;
  *) exit 0 ;;
esac

if printf '%s' "$HOOK_INPUT" | grep -qiE 'ALTER TABLE|CREATE TABLE|CREATE INDEX|DROP TABLE|DROP INDEX'; then
  hook_emit_context PreToolUse "CACHE_SCHEMA を編集しようとしています。変更は次回起動で全ユーザーのキャッシュ破棄＋フルスキャン再投入を伴います（src-tauri/CLAUDE.md「使い捨てスキーマ」参照）。意図した変更なら続行してください。"
fi
