#!/bin/bash
# フック共通部（各フックが source する）。
#
# モデルへ届く経路は hookSpecificOutput.additionalContext だけ。PreToolUse / PostToolUse では
# exit 0 の素の標準出力はデバッグログへ行き、モデルにもトランスクリプトにも現れない。
# 警告・検査結果は必ず hook_emit_context で出す（echo で出しても誰にも届かない）。

# stdin の tool 入力（JSON）を HOOK_INPUT に読み、編集対象のパスを HOOK_FILE_PATH に入れる。
# パスは Windows のバックスラッシュ区切りを / に正規化する。$TOOL_INPUT は存在しない。
# jq が無い・入力が JSON でないときは stderr に出して exit 1 で終える。黙って通すと
# 「警告が無い」と「フックが壊れている」の区別がつかない。exit 2 はツール呼び出しを止めるため使わない。
hook_read_input() {
  HOOK_INPUT=$(cat)
  local file_path
  if ! file_path=$(printf '%s' "$HOOK_INPUT" | jq -r '.tool_input.file_path // empty'); then
    echo "$(basename "$0"): tool 入力を読めません（jq の失敗）。フックは何も検査していません。" >&2
    exit 1
  fi
  file_path="${file_path%$'\r'}"
  HOOK_FILE_PATH="${file_path//\\//}"
}

# 非ブロックの通知をモデルへ届ける。$1 = フックイベント名（PreToolUse / PostToolUse）、$2 = 本文。
hook_emit_context() {
  jq -n --arg event "$1" --arg context "$2" \
    '{hookSpecificOutput: {hookEventName: $event, additionalContext: $context}}'
}

# 編集したファイルが属する作業ツリーの根を HOOK_WORKTREE に入れる。検査系のフックは、
# CLAUDE_PROJECT_DIR でなくここで検査する。ワークツリーで作業するセッションでも
# CLAUDE_PROJECT_DIR は元のチェックアウトを指すため、そこで検査すると、編集していない
# ツリー（元のチェックアウト）を検査して「問題なし」と黙ってしまう。
# 編集したファイルがこのプロジェクト（元のチェックアウトか、そのワークツリー。git の共通
# ディレクトリが CLAUDE_PROJECT_DIR と同じもの）の外なら 1 を返す。呼び出し側は検査しない。
hook_resolve_worktree() {
  local dir common project_common
  dir=$(dirname "$HOOK_FILE_PATH")
  while [ ! -d "$dir" ]; do
    local parent
    parent=$(dirname "$dir")
    [ "$parent" = "$dir" ] && return 1
    dir="$parent"
  done
  HOOK_WORKTREE=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || return 1
  common=$(git -C "$HOOK_WORKTREE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  project_common=$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  [ "$common" = "$project_common" ]
}
