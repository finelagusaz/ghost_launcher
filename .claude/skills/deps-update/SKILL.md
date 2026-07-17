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
- **メジャー更新**: 1 件ずつ changelog・breaking changes を確認し、ユーザーに更新可否を確認する
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

> **toolchain 更新（rustup stable の bump）時の clippy 再ゼロ化**: CI（`ci-build.yml`）は `dtolnay/rust-toolchain@stable`（浮動）で clippy を `-D warnings` ゲートしている。`cargo update` とは別に stable が上がると新 lint で CI が突然赤くなりうる。`rustup update` で stable を上げたら、依存更新と同一 PR かは問わず `cargo clippy --workspace --all-targets -- -D warnings` と bench 構成（`--features bench --all-targets`）を再実行し、**警告ゼロを回復してからコミットする**。toolchain は固定していない（新 lint を早期検知する方針・#175）。

## ステップ 5: コミットと PR

`/commit` → `/pr` へ接続する。更新内容（何をどの版からどの版へ）を PR 本文に列挙する。
