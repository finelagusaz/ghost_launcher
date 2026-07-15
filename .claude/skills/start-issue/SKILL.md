---
name: start-issue
description: GitHub issue への着手を定型化するプリステップ。ユーザーが「issue #N に着手」「issue #N やって」「/start-issue N」と言ったときに使う。
---

# issue 着手ワークフロー

GitHub issue を起点に、実装に入る直前までの準備を定型化する。

## 引数

- `$ARGUMENTS` に issue 番号（例: `99`）。無ければユーザーに確認する。

## ステップ 1: issue の把握

```bash
gh issue view <N>
```

タイトル・本文・ラベル・関連 issue を読み、要求を把握する。不明点があればユーザーに質問してから進む。

## ステップ 2: 作業ツリーの確認

`git status` が "nothing to commit, working tree clean" であることを確認する。未コミット変更がある場合は中断し、ユーザーに退避（コミット or stash）を確認する。

## ステップ 3: main の最新化（gh-HTTPS）

> SSH push/fetch が失敗するため、`/post-merge-sync` の「gh-HTTPS 方式」で迂回する（理由の詳細は同スキルが正典）。操作は pull + update-ref のみ差し替える。

```bash
git switch main
git -c credential.helper= -c credential.helper='!gh auth git-credential' \
  pull https://github.com/finelagusaz/ghost_launcher.git main --ff-only
git update-ref refs/remotes/origin/main "$(git rev-parse main)"
```

## ステップ 4: ブランチ作成

命名規則 `{prefix}/{issue番号}-{英語で内容の説明}` に従う（番号のみは不可）:

```bash
git switch -c <prefix>/<N>-<english-description>
```

プレフィックスは issue の性質から選ぶ: `feature/` `fix/` `hotfix/` `release/` `test/` `docs/` `refactor/`

## ステップ 5: 調査と方針提示

- issue の要求に関連するコード・SPEC.md の該当節を調査する
- 着手方針（変更対象ファイル・影響範囲・テスト方針）を短くまとめてユーザーに提示する
- 大きな変更なら plan モードでの設計提示を提案する

## ステップ 6: 実装へ

`/implement` へ接続する（調査結果を引き継ぎ、`/implement` のステップ 3「調査」から再開してよい）。
