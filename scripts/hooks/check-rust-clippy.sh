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

# ハーネスの打ち切り（.claude/settings.json の timeout 120 秒）より手前で自分で打ち切り、打ち切ったことを
# モデルへ知らせる。ハーネスに打ち切られたときにモデルへ何が届くかは確かめておらず、届く保証が無いため。
# 値は試験で縮められるよう環境変数で上書きできる。
timeout_seconds="${GHOST_HOOK_CLIPPY_TIMEOUT:-100}"

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 1
output=$(timeout "$timeout_seconds" cargo clippy --workspace --all-targets --quiet -- -D warnings 2>&1)
status=$?
if [ "$status" -eq 124 ]; then
  hook_emit_context PostToolUse "cargo clippy が ${timeout_seconds} 秒で終わらず、打ち切りました。clippy の結果は確かめていません。必要なら cargo clippy --workspace --all-targets -- -D warnings を手で実行してください。"
elif [ "$status" -ne 0 ]; then
  hook_emit_context PostToolUse "cargo clippy --workspace --all-targets -- -D warnings が失敗しました（末尾 30 行）:
$(printf '%s\n' "$output" | tail -30)"
fi
