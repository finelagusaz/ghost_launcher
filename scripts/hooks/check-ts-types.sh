#!/bin/bash
# PostToolUse hook (Edit|Write): .ts/.tsx 編集後に tsc --noEmit で型チェックし、失敗をモデルへ知らせる（非ブロック）。
# tsconfig.json は *.test.ts(x) を exclude するため、テストファイル自体の型エラーはここでも検出されない
# （src/CLAUDE.md「テストファイルは型検査されない」）。
# --incremental のキャッシュは作業ツリーごとの git ディレクトリに置く（コミット対象外で、
# ワークツリー同士でも混ざらない）。

. "$(dirname "$0")/_lib.sh"
hook_read_input

case "$HOOK_FILE_PATH" in
  *.ts | *.tsx) ;;
  *) exit 0 ;;
esac

# tsc は tsconfig.json を作業ツリーの根から解決する。編集したファイルの作業ツリーへ移動する
# （ワークツリーのセッションでは CLAUDE_PROJECT_DIR と違う）。
hook_resolve_worktree || exit 0
cd "$HOOK_WORKTREE" || exit 1

# tsc は Node の解決で探す。ワークツリーは自前の node_modules を持たず、親の元のチェックアウトの
# node_modules を使うことがあるため、作業ツリー直下の有無では判定しない。typescript は exports で
# bin/tsc を公開していないため、package.json を解決して bin.tsc から場所を求める。
# 依存未インストール時（fresh clone 直後など）は検査できない。黙って通さず、その旨を知らせる。
if ! tsc=$(node -p "const p = require.resolve('typescript/package.json'); require('path').join(require('path').dirname(p), require(p).bin.tsc)" 2>/dev/null); then
  hook_emit_context PostToolUse "型チェックのフックは走っていません（typescript を解決できない）。npm ci の後に npm run build で確認してください。"
  exit 0
fi

build_info="$(git rev-parse --path-format=absolute --git-dir)/hook-typecheck.tsbuildinfo"
if ! output=$(node "$tsc" --noEmit --pretty false --incremental --tsBuildInfoFile "$build_info" 2>&1); then
  hook_emit_context PostToolUse "tsc --noEmit が失敗しました（末尾 20 行）:
$(printf '%s\n' "$output" | tail -20)"
fi
