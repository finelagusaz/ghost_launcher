# CLAUDE.md

このファイルは、このリポジトリでコード作業を行う際の Claude Code（claude.ai/code）向けガイドです。

> `SPEC.md` で意図を管理し、コードで実装事実を管理する。`CLAUDE.md` はその橋渡しをする作業規約である。

## プロジェクト概要

Ghost Launcher は、伺か/SSP ゴーストを検出して起動するための Tauri 2 デスクトップアプリです。SSP のインストールディレクトリと追加のカスタムフォルダを走査し、`descript.txt`（Shift_JIS/UTF-8）からゴーストのメタデータを解析して、検索可能なランチャー UI を提供します。

## コミュニケーション方針

- **実行にバイアス**: 明確なタスクは分析・計画より実行を優先する。ユーザーが具体的な修正指示を出した場合は最小限の確認で着手する
- **コミット・PR は即実行**: コミットや PR 作成の指示は確認なしで実行する
- **分析は発見事項のみ**: 分析を求められたら発見事項のみを報告し、求められていない実装計画には踏み込まない
- **不明点は先に質問**: 着手前に不明点がある場合は、作業を始める前にまとめて質問する

## 言語

UI テキストはすべて日本語です。Rust ファイル内のコードコメントも日本語です。

## コマンド

```bash
# 開発（Vite 開発サーバーと Tauri を同時起動）
npm run tauri dev

# フロントエンドのみ（Vite 開発サーバー: ポート 1420）
npm run dev

# フロントエンドをビルド
npm run build

# Rust バックエンドのコンパイル確認
cd src-tauri && cargo check

# Rust テストの実行
cargo test --manifest-path src-tauri/Cargo.toml

# ghost-meta クレートのテスト実行
cargo test --manifest-path crates/ghost-meta/Cargo.toml

# アプリ全体をビルド
npm run tauri build

# E2E テストのセットアップ（初回のみ・tauri-driver と EdgeDriver を用意）
npm run e2e:setup

# E2E テストの実行（事前に npm run tauri build が必要）
npm run e2e
```

## ディレクトリ構成

```
ghost_launcher/
├── src/                        # フロントエンド（React 19 / TypeScript）→ src/CLAUDE.md
│   ├── lib/                    # Tauri 呼び出し・ビジネスロジック
│   ├── hooks/                  # React カスタムフック
│   ├── components/             # React コンポーネント
│   └── App.tsx                 # ルートコンポーネント
├── src-tauri/                  # Rust バックエンド → src-tauri/CLAUDE.md
│   └── src/
│       ├── commands/
│       │   ├── ghost/          # ゴーストスキャン・フィンガープリント
│       │   ├── ssp.rs          # ゴースト起動・SSP パス検証コマンド
│       │   ├── db.rs           # DB リセット（マイグレーション失敗時の自動回復）
│       │   └── locale.rs       # ユーザー言語ファイル読込
│       ├── db_path.rs          # ghosts.db パス解決の単一権威
│       └── lib.rs              # Tauri アプリビルダー
├── crates/ghost-meta/          # ゴーストメタデータ解析クレート
│   └── src/                    # descript.txt パーサー・ゴースト走査・サムネイル解決
├── e2e/                        # E2E テスト → e2e/CLAUDE.md
│   ├── helpers/
│   │   ├── harness.ts          # tauri-driver 起動・WebDriver セッション管理
│   │   └── ui.ts               # 共通 UI ヘルパー（waitForAppReady など）
│   ├── ghost-list.e2e.ts       # ゴースト一覧・検索・スクロールの E2E テスト
│   └── i18n.e2e.ts             # 言語切り替え・NFKC 正規化の E2E テスト
├── docs/
│   ├── ui-guidelines.md        # UI デザインガイドライン
│   └── locale-customization.md # ユーザー言語カスタマイズ仕様
├── Cargo.toml                  # workspace ルート（src-tauri + crates/ghost-meta）
├── RETROSPECTIVE.md            # 過去の振り返り（サイクル毎に上書き）
└── SPEC.md                     # 機能仕様書
```

## アーキテクチャ

**Tauri 2 アプリ**: Rust バックエンド + React 19 / TypeScript フロントエンド。

### バックエンド（`src-tauri/src/` + `crates/ghost-meta/`）

- `lib.rs` — Tauri アプリビルダー。コマンド・プラグイン登録・SQLite マイグレーション
- `commands/ghost/` — ゴーストスキャン・DB 書き込み・フィンガープリントコマンド群。`scan.rs`（Rayon 並列スキャン + 型変換）、`store.rs`（rusqlite 差分 UPSERT）、`fingerprint.rs`（2 層差分検知）、`path_utils.rs`（パス正規化）、`types.rs`（型定義）
- `commands/ssp.rs` — `launch_ghost`（`ssp.exe /g {ghost}` 起動）・`validate_ssp_path` コマンド
- `crates/ghost-meta/` — ゴーストメタデータ解析ワークスペースクレート。`descript.txt` パーサー・ゴースト走査・サムネイル解決

### フロントエンド（`src/`）

- `lib/` — Tauri コマンド呼び出しラッパー・キャッシュ寿命管理・起動ロジック・設定ストア
- `hooks/` — 設定・ゴーストスキャン・検索・仮想スクロール・テーマ検出などの React カスタムフック
- `components/` — AppHeader / SettingsPanel / GhostContent / GhostList / GhostCard / SearchBox

### 横断パターン

**Tauri コマンド呼び出し**: フロントエンドは `invoke()` で camelCase の引数名を使い、Rust 側では自動的に snake_case に変換されます（例: `sspPath` → `ssp_path`, `additionalFolders` → `additional_folders`）。

**ゴーストのディレクトリ構造**: `{parent}/ghost/{ghost_name}/ghost/master/descript.txt`。`parent` は `{ssp_path}`（SSP ネイティブゴースト用）または、ゴーストサブディレクトリを直接含むユーザー指定の追加フォルダです。

**Claude Code フック**: `.claude/settings.json` のフックは `scripts/hooks/*.sh` を `bash "$CLAUDE_PROJECT_DIR/..."`（絶対パス）で呼ぶ。tool 入力は **stdin の JSON** で渡り `jq -r '.tool_input.file_path'` で取り出す（`$TOOL_INPUT` は存在しない。フックの cwd も保証されないので相対パス厳禁）。

## 開発方針

- **KISS**: シンプルさを最優先する。1つの関数は1つのことだけを行い、短く保つ。到達不能なフォールバックや使われない汎用化は書かない
- **DRY**: 同一ロジックの繰り返しを避ける。ただし無理な抽象化よりも多少の重複を許容する（2回までは許容、3回目で抽出を検討）
- **SRP**: 各モジュール・関数・コンポーネントは単一の責務を持つ。複数の責務が混在したら分割する
- **YAGNI**: 現在の要件に必要なコードだけを書く。「将来必要になるかもしれない」機能・抽象化・設定項目は作らない
- **既存パターン踏襲**: 新規コードは既存のファイル構成・命名規則・スタイルパターンに合わせる。独自の新しいパターンを導入する前に既存パターンの利用を検討する
- **根本原因の修正**: バグ修正後に症状が別のテストやコードに移動した場合、根本原因に未達のサイン。「なぜ直ったか」を確認し、同一パターンのバグが他のコードパスに存在しないか検索してから修正を完了する

## 作業フロー

コード変更（機能追加・バグ修正・リファクタリング）は `/implement` スキルのフローに従う。issue 起点の作業は `/start-issue` から始める。実装完了 = コミット済みの状態にし、`git status` が clean になるまでセッションを終了しない。

## 利用できるスキル

| スキル | 実行時期 | 用途 |
|---|---|---|
| `/start-issue` | issue 着手時 | ブランチ作成〜調査・計画のプリステップ |
| `/implement` | 実装開始時 | 調査→テスト先行→実装→検証→コミットの全サイクル |
| `/ipc-check` | IPC 境界変更時 | Rust↔TS 契約・モック契約の監査 |
| `/symmetry-check` | コード変更時 | 対称パス適用漏れ・コピー統合検討 |
| `/cache-check` | キャッシュ・状態変更時 | 2 層キャッシュ・fingerprint 整合検証 |
| `/health-check` | 定期・サイクル完了後 | SPEC/docs と実装の乖離検査（報告のみ） |
| `/retrospective` | サイクル終了後 | 教訓抽出→RETROSPECTIVE.md 上書き |
| `/deps-update` | 依存更新時 | cargo/npm 一括更新と検証 |
| `/commit` | コミット時 | コミット前チェックリスト実行→コミット |
| `/pr` | PR 作成時 | 変更分析→gh-HTTPS push→PR 作成 |
| `/e2e` | E2E 実行時 | 環境固有の E2E 実行手順 |
| `/post-merge-sync` | PR マージ後 | main 同期・ブランチ後始末 |

## デバッグ・バグ修正の原則

- **不変条件の特定**: 修正に着手する前に、壊れているはずの不変条件を言語化する。「何が常に真でなければならないか」を明確にしてからコードを読む
- **推測の連鎖を避ける**: 最初の修正仮説が失敗したら、同じ方向に推測を重ねず、より深い調査（ログ追加・テスト追加）に切り替える
- **同一パターンの検索**: 修正前にコードベース全体を検索し、同一パターンのバグが他のコードパスに潜んでいないか確認する
- **症状の移動に注意**: 修正後に別のテストが失敗し始めた場合、根本原因に未達のサイン。症状を移動させるだけの修正は完了とみなさない

## コミット前チェックリスト

`/commit` スキルが単一権威。コミットは常に `/commit` のチェックリスト全パス後に行う。

## ブランチ戦略

GitHub Flow に準拠する。

### 基本ルール

- `main` ブランチは常にデプロイ可能な状態を保つ
- すべての作業は `main` から派生したブランチで行う
- ブランチは PR マージ後に速やかに削除する
- ブランチを作成する前に `git status` が "nothing to commit, working tree clean" であることを確認する

### ブランチ命名規則

形式: `{prefix}/{issue番号}-{英語で内容の説明}`
プレフィックス: `feature/` | `fix/` | `hotfix/` | `release/` | `test/` | `docs/` | `refactor/`
例: `fix/15-validation-cancel-error`, `feature/15-ghost-folder-sorting`。番号のみ（`fix/15`）は不可。

### PR 運用

1. `main` から作業ブランチを作成
2. 作業単位でこまめにコミット（実装完了 = コミット済みかつ CI が通る状態）
3. **フェーズ分けの作業では、全フェーズ完了後に一括で PR を作成する**（途中フェーズで PR を開くと、後から同一ブランチに追加されたコミットが PR タイトルと乖離し、マージ済み確認が困難になる）
4. コミット前チェックリスト（`/commit`）がすべて通ることを確認してから PR を作成
5. PR マージ後にブランチを削除
6. 複数 PR を並行して進める場合: 一方が CI 失敗すると main ベースの他の PR もマージできなくなる。CI 失敗の原因が共有コード（Rust テスト等）にある場合は優先して修正 PR を立てる

### スカッシュマージのマージ済み確認

スカッシュマージでは元コミットが main の祖先に入らないため、`git log main..branch` は「未マージ」と誤検知する。内容が main に取り込まれているかは `git diff main..branch --stat` で判断する。差分がほぼゼロなら実質マージ済み。

## CLAUDE.md の保守ルール

- **短さが正義**: 読まれないルールは存在しないのと同じ。追記する前に「これは本当にここに要るか」を問う
- **コードの近くに置く**: フォルダ固有の知識はそのフォルダの `CLAUDE.md` に書く。作業者の視線の先にルールがあることが重要
- **更新タイミング**: 実装・レビュー・修正が完了し、パターンとして確定したときに更新する。作業中の仮説や未検証の知見は書かない
- **1 in 1 out を意識する**: 新しいルールを足すとき、不要になったルールの削除を検討する

## 参照ドキュメント

- `SPEC.md` — 機能仕様書。振る舞いを変更する場合は実装と同期させる
- `docs/ui-guidelines.md` — UI デザインガイドライン
- `docs/locale-customization.md` — ユーザー言語カスタマイズ仕様
- `RETROSPECTIVE.md` — 過去の振り返り（デバッグ教訓・アーキテクチャ上の学び）
  - **更新タイミング**: サイクル終了後（実装・レビュー・追加修正まで完了したとき）
  - **更新方法**: 上書き（追記しない）。前回サイクルの内容を新サイクルの振り返りで置き換える
  - **更新手順**: 新しいパターン・教訓を先に `CLAUDE.md` / `ui/CLAUDE.md` / スキルに抽出してから、`RETROSPECTIVE.md` を上書きする。抽出前に上書きすると教訓が失われる
