---
name: post-merge-sync
description: PR マージ後に main をローカル同期し、作業ブランチを後始末する。ユーザーが「マージ後の同期」「post-merge-sync」「ブランチ片付けて」と言ったときに使う。この環境は SSH push/fetch が壊れているため gh-HTTPS 経由で行う。
disable-model-invocation: true
---

# マージ後の同期・後始末ワークフロー

GitHub 上で PR がマージされた後、ローカル `main` を最新化し、作業ブランチを安全に削除する。

> **この環境固有の制約**: `origin`（`git@github.com:finelagusaz/ghost_launcher.git`、SSH）への `git push`/`fetch` は `~/.ssh/config` の ACL で失敗する。`gh` はトークン認証済みのため、HTTPS + gh 資格情報ヘルパーで迂回する。SSH remote にも永続 git config にも触れない。

## 引数

- `$ARGUMENTS` に PR 番号（例: `83`）またはブランチ名があれば使う。無ければ現在のブランチを対象とする。

## ステップ 1: マージ済みの確認

```bash
gh pr view <PR番号 or ブランチ> --json number,state,headRefName,mergedAt
```

`state` が `MERGED` でなければ中断し「PR がまだマージされていません」と伝える。`headRefName` を対象ブランチ名として控える。

## ステップ 2: リモートブランチの削除（API 経由）

```bash
gh api -X DELETE repos/finelagusaz/ghost_launcher/git/refs/heads/<branch>
```

（GitHub の自動削除設定で既に消えている場合は 404。無視してよい。）

## ステップ 3: main をローカル同期（gh-HTTPS）

```bash
git switch main
git -c credential.helper= -c credential.helper='!gh auth git-credential' \
  pull https://github.com/finelagusaz/ghost_launcher.git main --ff-only
```

## ステップ 4: 追跡参照を整える

URL 指定の pull は `refs/remotes/origin/main` を更新しないため、`status` が "ahead by N" と誤表示する。`update-ref` で揃える:

```bash
git update-ref refs/remotes/origin/main "$(git rev-parse main)"
```

> **禁止**: `git fetch <url> main:refs/remotes/origin/main` は `refs/remotes/origin/main` と `origin/HEAD` を壊して `[gone]` 化させる。追跡参照の同期は必ず `update-ref` で行う。

## ステップ 5: ローカル作業ブランチの削除

```bash
git branch -D <branch>
```

（スカッシュマージでは元コミットが main の祖先に入らないため `-d` は「未マージ」と誤検知する。内容が取り込まれているかは `git diff main..<branch> --stat` がほぼゼロであることで確認済みなら `-D` で削除してよい。）

## ステップ 6: 結果の報告

`git log --oneline -3 main` と `git status` を示し、main が最新・作業ツリーが clean になったことを伝える。
