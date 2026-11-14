#!/bin/bash
# PostToolUse hook (Edit|Write): .rs 編集後に cargo clippy を実行し、失敗をモデルへ知らせる（非ブロック）。
# フラグは ci-build.yml の「Clippy (workspace, deny warnings)」に揃える（規範。乖離は /health-check 項目 6 で見る）。
# -D warnings が無いと警告は exit 0 のまま通り、warn レベルの lint（clippy.toml の disallowed-methods 等）を
# このフックは一切報告できない。

. "$(dirname "$0")/_lib.sh"
hook_read_input

case "$HOOK_FILE_PATH" in
  *.rs) ;;
  *) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 1
if ! output=$(cargo clippy --workspace --all-targets --quiet -- -D warnings 2>&1); then
  hook_emit_context PostToolUse "cargo clippy --workspace --all-targets -- -D warnings が失敗しました（末尾 30 行）:
$(printf '%s\n' "$output" | tail -30)"
fi
