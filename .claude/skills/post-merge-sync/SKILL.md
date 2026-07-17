---
name: post-merge-sync
description: PR マージ後に main をローカル同期し、作業ブランチを後始末する。ユーザーが「マージ後の同期」「post-merge-sync」「ブランチ片付けて」と言ったとき、または PR のマージ後に使う。
disable-model-invocation: true
---

# マージ後の同期・後始末ワークフロー

GitHub 上で PR がマージされた後、ローカル `main` を最新化し、作業ブランチを安全に削除する。

> `origin` は HTTPS remote、認証は Git Credential Manager が担うため、標準の `git pull`/`git push origin` がそのまま通る。特別な迂回は不要。

## 引数

- `$ARGUMENTS` に PR 番号（例: `83`）またはブランチ名があれば使う。無ければ現在のブランチを対象とする。

## ステップ 1: マージ済みの確認

```bash
gh pr view <PR番号 or ブランチ> --json number,state,headRefName,mergedAt
```

`state` が `MERGED` でなければ中断し「PR がまだマージされていません」と伝える。`headRefName` を対象ブランチ名として控える。

> リモートブランチは GitHub の auto-delete-on-merge 設定でマージ時に自動削除される。手動削除は不要。万一残っていれば `git push origin --delete <branch>` で消す。

## ステップ 2: main をローカル同期

```bash
git switch main
before_sync=$(git rev-parse HEAD)   # ステップ 3 の依存再同期の差分基点（pull 前の tip を控える）
git pull origin main --ff-only
```

## ステップ 3: 依存の再同期（lockfile 変更時のみ）

pull が lockfile を更新していたら、ローカルの依存を実体に合わせる。更新漏れのまま作業に入ると、`npm run build` が `@types/node` 欠落等で失敗し、コードの問題と切り分けにくい（#176 で実測）。判定は裁量でなく**機械的に**行う:

```bash
git diff --name-only "$before_sync"..HEAD -- package-lock.json Cargo.lock
```

- 出力に `package-lock.json` があれば `npm install`
- 出力に `Cargo.lock` があれば `cargo fetch`
- 出力が空なら何もしない（依存は不変）

## ステップ 4: ローカル作業ブランチの削除

```bash
git branch -D <branch>
```

（スカッシュマージでは元コミットが main の祖先に入らないため `-d` は「未マージ」と誤検知する。内容が取り込まれているかは `git diff main..<branch> --stat` がほぼゼロであることで確認済みなら `-D` で削除してよい。）

## ステップ 5: 結果の報告

`git log --oneline -3 main` と `git status` を示し、main が最新・作業ツリーが clean になったことを伝える。
