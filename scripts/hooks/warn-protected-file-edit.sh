#!/bin/bash
# PreToolUse hook (Edit|Write): ロックファイル・.env の手編集時に警告する（非ブロック）。
# Cargo.lock / package-lock.json はパッケージマネージャ（cargo/npm）が管理する生成物で、
# 手編集すると依存解決が壊れる。.env 系は秘匿情報で手編集・コミットを避ける。
# tool 入力は stdin の JSON で渡る（.tool_input.file_path）。$TOOL_INPUT は存在しない。

file_path=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
# Windows のバックスラッシュ区切りを正規化してからファイル名判定する。
fp="${file_path//\\//}"
case "$fp" in
  */Cargo.lock | */package-lock.json | */.env | */.env.*) ;;
  *) exit 0 ;;
esac

echo "保護対象ファイル（$fp）を編集しようとしています。ロックファイルは npm/cargo 経由で更新し、.env 系は手編集・コミットを避けてください。意図的な場合のみ続行してください。"
exit 0
