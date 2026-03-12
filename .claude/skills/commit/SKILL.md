---
name: commit
description: コミット前チェックリストを実行し、全パスしたらコミットする。ユーザーが「コミットして」「/commit」と言ったときに使う。チェック失敗時は修正を提案する。
---

# Commit ワークフロー

コミット前チェックリスト（CLAUDE.md 準拠）を実行し、全パス後にコミットを作成する。

## ステップ 1: 変更内容の把握

以下の 3 コマンドを**並列で**実行する:

```bash
git status                     # 変更ファイル一覧
git diff --stat                # 差分の概要（staged + unstaged）
git log --oneline -5           # 直近のコミットメッセージスタイル確認
```

**中断条件**: 変更がない（`nothing to commit, working tree clean`）場合は「コミットする変更がありません。」と伝えて終了する。

## ステップ 2: コミット前チェックリスト

以下を**可能な限り並列で**実行する:

```bash
# グループ A（並列実行）
npm run build
npm test
npm run check:ui-guidelines
npm run test:ui-guidelines-check

# グループ B（並列実行）
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path crates/ghost-meta/Cargo.toml
```

グループ A とグループ B は互いに独立しているため並列実行してよい。

### チェック失敗時の対応

- **1 件でも失敗した場合**: コミットしない。失敗したチェックの出力を示し、修正を提案する
- **修正後**: 失敗したチェックのみ再実行する（全チェックのやり直しは不要）
- **ユーザーが「スキップして」と明示した場合のみ**: チェック失敗を無視してコミットしてよい

## ステップ 3: ステージングとコミット

### ステージング

- 変更ファイルを確認し、ファイル名を指定して `git add` する
- `git add -A` や `git add .` は使わない（`.env` や大きなバイナリの混入防止）
- `.env`、`credentials`、秘密鍵など機密ファイルが含まれていたら警告して除外する

### コミットメッセージ

変更内容を分析し、conventional commits 形式のメッセージを作成する:

- **prefix**: `feat:` / `fix:` / `refactor:` / `perf:` / `docs:` / `test:` / `chore:`
- **言語**: 日本語（このプロジェクトの慣習に従う）
- **構成**: 1 行目に要約、必要に応じて空行 + 詳細
- **Co-Authored-By**: 末尾に `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>` を付与

```bash
git commit -m "$(cat <<'EOF'
prefix: コミットメッセージ

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

### コミット後

`git status` を実行して clean になったことを確認する。

## 注意事項

- `--amend` は使わない（前のコミットを破壊するリスク）
- `--no-verify` は使わない（hook をスキップしない）
- push はしない（`/pr` スキルの責務）
- コミットメッセージにファイル一覧を列挙しない（「何を変えたか」ではなく「なぜ変えたか」を書く）
