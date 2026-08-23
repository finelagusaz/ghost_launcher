---
name: deps-update
description: cargo/npm の依存を一括更新し検証する。ユーザーが「依存更新して」「deps 更新」「/deps-update」と言ったときに使う。
disable-model-invocation: true
---

# 依存更新ワークフロー

npm と cargo の依存を安全に更新する。

## ステップ 1: 現状把握

以下を並列で実行する:

```bash
npm outdated
cargo update --dry-run
```

## ステップ 2: 更新方針の判断

- **パッチ・マイナー更新**: 一括で進めてよい
- **メジャー更新**: 1 件ずつ changelog・breaking changes を確認し、ユーザーに更新可否を確認する。**波及範囲は changelog の散文でなくパッケージメタデータで実測する**（`npm view <pkg>@<ver> engines exports peerDependencies`）。見送って issue 化する場合もこの実測結果を issue に書く（想定で書くと着手時にスコープごと覆る。#185 は「マッチャー波及」を懸念して起票したが、実際の争点は `engines.node` と CI のランタイム版だった）
- **上流の変更が意図的か先に確かめる**: 更新で壊れたとき、原因を「上流の不備」と決めつけない。changelog が設計判断として名指ししているなら（例: Fluent UI 9.74.6 の ESM-first 化は `drop the node export condition` と明記）、**待っても直らないため「上流の修正を待つ」は選択肢にならず、追随か据え置きの二択になる**。見送りを issue 化する際もこの区別を書く（#203 は当初「上流の不備・修正待ち」と書き、ユーザーの指摘で全面改訂した）
- **`Cargo.lock` に増えたクレートを供給網の増加と即断しない**: optional dependency は feature が有効化されなくても lock に記録される。`cargo tree -i <crate>`（必要なら `--target all`）と突き合わせ、ビルドグラフに現れないなら実際にコンパイルされるクレートは増えていない。lock と `cargo tree` の食い違いそのものが答えになる
- **tauri 系**（`@tauri-apps/cli` / `@tauri-apps/api` / 各プラグイン / `tauri` クレート）: CLI・api・プラグインの版を揃える
- **rusqlite / libsqlite3-sys**: `tauri-plugin-sql` との links 制約で上限が固定されている。`src-tauri/CLAUDE.md`「rusqlite と sqlx-sqlite の libsqlite3-sys 共有制約」を読み、解錠条件を満たしていない限り major bump しない
- **シリアライズ・ストレージ形式に関わるクレート**: 後方互換性の検証手順（`src-tauri/CLAUDE.md`「依存クレートの移行・更新」）に従う

## ステップ 3: 更新の実行

```bash
npm update          # package.json の semver 範囲内
cargo update        # Cargo.lock の更新
```

範囲を超える更新（メジャー）は `package.json` / `Cargo.toml` を個別に編集する。

## ステップ 4: 検証

`/commit` のコミット前チェックリストを全実行する。UI に波及しうる更新（React・Fluent UI・i18next・tauri 系）の場合は `/e2e` の手動実行を推奨する。

> **toolchain 更新（rustup stable の bump）時の clippy 再ゼロ化**: CI（`ci-build.yml`）は `dtolnay/rust-toolchain@stable`（浮動）で clippy を `-D warnings` ゲートしている。`cargo update` とは別に stable が上がると新 lint で CI が突然赤くなりうる。`rustup update` で stable を上げたら、依存更新と同一 PR かは問わず `cargo clippy --workspace --all-targets -- -D warnings` と bench 構成（`--features bench --all-targets`）を再実行し、**警告ゼロを回復してからコミットする**。toolchain は固定していない（新 lint を早期検知する方針・#175）。**順序が重要**: toolchain を先に上げ、**依存を変更していないツリーで**ベースラインを取ってから依存更新に入る。逆順だと赤が出たとき「新 lint 由来」か「新版由来」かを切り分けられない。

> **Node ランタイムの EOL 確認**: Rust とは非対称で、CI の `node-version` は明示ピン（浮動でない）。放置しても赤くならず、静かに EOL のランタイムで回り続ける。依存更新のたびに `node -v`・`ci-build.yml` / `release.yml` の `node-version`・[Node のリリース予定](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json) を突き合わせる。`.npmrc` が無く `engine-strict` は既定 off のため、`engines.node` を満たさない依存を入れても `npm ci` は警告どまりで失敗しない——**CI の赤は検知手段にならない**（#185 で EOL 経過後の Node 20 を検出）。

## ステップ 5: コミットと PR

`/commit` → `/pr` へ接続する。更新内容（何をどの版からどの版へ）を PR 本文に列挙する。
