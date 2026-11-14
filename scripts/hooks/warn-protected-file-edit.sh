#!/bin/bash
# PreToolUse hook (Edit|Write): ロックファイル・.env の手編集時に警告する（非ブロック）。
# Cargo.lock / package-lock.json はパッケージマネージャ（cargo/npm）が管理する生成物で、
# 手編集すると依存解決が壊れる。.env 系は秘匿情報で手編集・コミットを避ける。

. "$(dirname "$0")/_lib.sh"
hook_read_input

case "$HOOK_FILE_PATH" in
  */Cargo.lock | */package-lock.json | */.env | */.env.*) ;;
  *) exit 0 ;;
esac

hook_emit_context PreToolUse "保護対象ファイル（$HOOK_FILE_PATH）を編集しようとしています。ロックファイルは npm/cargo 経由で更新し、.env 系は手編集・コミットを避けてください。意図的な場合のみ続行してください。"
