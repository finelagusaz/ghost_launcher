#!/bin/bash
# PostToolUse hook (Edit|Write): .ts/.tsx 編集後に tsc --noEmit で型チェックし、失敗をモデルへ知らせる（非ブロック）。
# tsconfig.json は *.test.ts(x) を exclude するため、テストファイル自体の型エラーはここでも検出されない
# （src/CLAUDE.md「テストファイルは型検査されない」）。
# --incremental のキャッシュは node_modules/.cache 配下に置き、コミット対象外にする。

. "$(dirname "$0")/_lib.sh"
hook_read_input

case "$HOOK_FILE_PATH" in
  *.ts | *.tsx) ;;
  *) exit 0 ;;
esac

# tsc は tsconfig.json をルートから解決するため、プロジェクトルートへ移動する。
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 1

# 依存未インストール時（fresh clone 直後など）は検査できない。黙って通さず、その旨を知らせる。
if [ ! -f node_modules/typescript/bin/tsc ]; then
  hook_emit_context PostToolUse "型チェックのフックは走っていません（node_modules/typescript が無い）。npm ci の後に npm run build で確認してください。"
  exit 0
fi

mkdir -p node_modules/.cache
if ! output=$(node node_modules/typescript/bin/tsc --noEmit --pretty false --incremental \
  --tsBuildInfoFile node_modules/.cache/hook-typecheck.tsbuildinfo 2>&1); then
  hook_emit_context PostToolUse "tsc --noEmit が失敗しました（末尾 20 行）:
$(printf '%s\n' "$output" | tail -20)"
fi
