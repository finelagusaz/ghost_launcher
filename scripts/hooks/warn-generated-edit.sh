#!/bin/bash
# PreToolUse hook (Edit|Write): src/types/generated/ の ts-rs 生成ファイル編集時に警告する（非ブロック）。
# これらは Rust struct（commands/ghost/types.rs の #[ts(export)]）から cargo test 時に自動生成される。
# 手編集はドリフトの元（生成物と Rust struct が乖離し、CI の生成型照合で落ちる）。

. "$(dirname "$0")/_lib.sh"
hook_read_input

case "$HOOK_FILE_PATH" in
  */src/types/generated/*) ;;
  *) exit 0 ;;
esac

hook_emit_context PreToolUse "src/types/generated/ は ts-rs 生成ファイルです。手編集せず、Rust struct（src-tauri/src/commands/ghost/types.rs）を変更して 'cargo test --workspace' で再生成してください（src-tauri/CLAUDE.md「IPC 型の管理」参照）。"
