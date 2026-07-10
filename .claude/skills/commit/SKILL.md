---
name: commit
description: ユーザーが「コミットして」「/commit」と言ったとき、または作業フロー（/implement 等）の締めでコミットが必要になったときに使う。
---

# Commit ワークフロー

コミット前チェックリスト（本スキルが単一権威）を実行し、全パス後にコミットを作成する。

## ステップ 1: 変更内容の把握

以下の 3 コマンドを**並列で**実行する:

```bash
git status                     # 変更ファイル一覧
git diff --stat                # 差分の概要（staged + unstaged）
git log --oneline -5           # 直近のコミットメッセージスタイル確認
```

**中断条件**: 変更がない（`nothing to commit, working tree clean`）場合は「コミットする変更がありません。」と伝えて終了する。

## ステップ 2: コミット前チェックリスト

> **docs-only の免除**: 変更が `*.md` ファイルのみに閉じている場合、下記のコード系ゲートは検証対象（`src/`・`src-tauri/`・`crates/`）が不変のため非該当。実行を省き、その旨をコミットメッセージに記す。`.md` 以外（`package.json`・CI 設定・コード等）が 1 つでも含まれるなら全ゲートを実行する。

以下を**可能な限り並列で**実行する:

```bash
# グループ A（並列実行）
npm run build
npm test
npm run check:ui-guidelines
npm run test:ui-guidelines-check

# グループ B（順次実行。CI の ci-build.yml と同一コマンド）
cargo test --workspace
cargo test -p ghost-meta --features thumbnail,serde
```

グループ A とグループ B は互いに独立しているため並列実行してよい（グループ B 内は target ディレクトリのロック競合を避けるため順次）。

### 追加の確認事項

- **新規テストファイルを追加した場合**: `ci-build.yml` で実行されるか・`tsconfig.json` の `exclude` に追加が必要か・`vitest.config.ts` の `include` が検出するかを確認する
- **UI 操作・言語表示・フォーム入力に関わる変更の場合**: E2E テスト（`/e2e`）の手動実行を済ませたか確認する（E2E は CI に含まれない）
- **生成型の照合（CI の「Verify generated types are committed」と同一ゲート）**: `cargo test --workspace` 後に `git status --porcelain src/types/generated/` を確認し、差分・未追跡ファイルが出たらコミットに含める

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
- **Co-Authored-By**: 末尾にハーネス既定の Co-Authored-By 行を付与する（モデル名をこのスキルにハードコードしない。ハーネスの指示に従う）

```bash
git commit -m "$(cat <<'EOF'
prefix: コミットメッセージ

Co-Authored-By: <ハーネス既定の表記>
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
