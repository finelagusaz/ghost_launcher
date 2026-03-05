---
name: pr
description: PR の作成を一気通貫で実行するスキル。ユーザーが「PR 作って」「PR お願い」「/pr」と言ったとき、または作業完了後に PR 作成を依頼されたときに使う。ブランチの変更内容を分析し、conventional commits 形式のタイトルと構造化された本文を生成して GitHub PR を作成する。コミット済みの作業ブランチ（main 以外）で使うことを想定している。
---

# PR ワークフロー

現在のブランチの変更内容を分析し、GitHub PR を作成するワークフローを実行する。

## 前提条件

- 現在のブランチが `main` 以外であること
- PR に含めたいコミットが `main..HEAD` に存在すること
- `gh` CLI が認証済みであること

## 実行手順

### ステップ 1: 状態確認

以下の 3 コマンドを**並列で**実行し、現在の状態を把握する:

```bash
git status                    # 未コミット変更の有無
git diff main...HEAD --stat   # PR に含まれるファイル変更の概要
git log --oneline main..HEAD  # PR に含まれるコミット一覧
```

**中断条件**: `main..HEAD` にコミットが 1 件もない場合は「PR に含めるコミットがありません。先にコミットしてください。」と伝えて終了する。

**警告**: 未コミット変更がある場合は「未コミットの変更があります。先にコミットしますか？」とユーザーに確認する。

### ステップ 2: 変更内容の分析

`git diff main...HEAD` の全体（`--stat` なし）と各コミットメッセージを読み、以下を判断する:

- **変更の性質**: 新機能（feat）、バグ修正（fix）、リファクタリング（refactor）、ドキュメント（docs）、テスト（test）、その他
- **影響範囲**: どのモジュール・レイヤーに変更が及んでいるか
- **要点**: ユーザーが PR レビュアーに伝えたい核心は何か

### ステップ 3: リモートへの push

ブランチがリモートに push 済みか確認し、必要なら push する:

```bash
git push -u origin HEAD
```

### ステップ 4: PR の作成

分析結果をもとに PR を作成する。

**タイトルのルール**:
- conventional commits 形式: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:` 等
- 70 文字以内
- 日本語でも英語でもよい（コミットメッセージの言語に合わせる）

**本文のテンプレート**:

```
gh pr create --base main --title "タイトル" --body "$(cat <<'EOF'
## Summary
- 変更点 1
- 変更点 2
- 変更点 3

## Test plan
- [x] 検証済み項目
- [ ] 未検証項目（該当する場合）

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Test plan の書き方**:

このプロジェクトのコミット前チェックリストに基づき、実際に検証した項目をチェック済みで記載する:

- `npm run build`
- `npm test`
- `npm run check:ui-guidelines`
- `npm run test:ui-guidelines-check`
- `cargo test --manifest-path src-tauri/Cargo.toml`（Rust 変更がある場合）

コード変更を伴わない PR（ドキュメントのみ等）では、該当しないチェック項目は省略してよい。

### ステップ 5: 結果の報告

PR の URL をユーザーに伝える。シンプルに URL だけでよい。

## 注意事項

- コミットされていない変更を勝手にコミットしない。ユーザーに確認を取る
- PR 本文の HEREDOC 内にシングルクォートの `EOF` を使い、変数展開を防ぐ
- ベースブランチは常に `main`
- 同名の PR が既に存在する場合は `gh pr list` で確認し、ユーザーに報告する
