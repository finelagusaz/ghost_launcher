#!/bin/bash
# PreToolUse hook (Edit|Write): src/types/generated/ の ts-rs 生成ファイル編集時に警告する（非ブロック）。
# これらは Rust struct（commands/ghost/types.rs の #[ts(export)]）から cargo test 時に自動生成される。
# 手編集はドリフトの元（生成物と Rust struct が乖離し、CI の生成型照合で落ちる）。
# tool 入力は stdin の JSON で渡る（.tool_input.file_path）。$TOOL_INPUT は存在しない。

file_path=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
# Windows のバックスラッシュ区切りを正規化してからディレクトリ判定する。
fp="${file_path//\\//}"
case "$fp" in
  */src/types/generated/*) ;;
  *) exit 0 ;;
esac

echo "src/types/generated/ は ts-rs 生成ファイルです。手編集せず、Rust struct（src-tauri/src/commands/ghost/types.rs）を変更して 'cargo test --manifest-path src-tauri/Cargo.toml' で再生成してください（src-tauri/CLAUDE.md・docs/superpowers の drift-hardening 参照）。"
exit 0
