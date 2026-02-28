# CLAUDE.md

このファイルは、このリポジトリでコード作業を行う際の Claude Code（claude.ai/code）向けガイドです。

> `SPEC.md` で意図を管理し、コードで実装事実を管理する。`CLAUDE.md` はその橋渡しをする作業規約である。

## プロジェクト概要

Ghost Launcher は、伺か/SSP ゴーストを検出して起動するための Tauri 2 デスクトップアプリです。SSP のインストールディレクトリと追加のカスタムフォルダを走査し、`descript.txt`（Shift_JIS/UTF-8）からゴーストのメタデータを解析して、検索可能なランチャー UI を提供します。

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
├── src/                        # フロントエンド（React 19 / TypeScript）
│   ├── lib/                    # Tauri 呼び出し・ビジネスロジック
│   ├── hooks/                  # React カスタムフック
│   ├── components/             # React コンポーネント
│   └── App.tsx                 # ルートコンポーネント
├── src-tauri/
│   └── src/
│       ├── commands/
│       │   ├── ghost/          # ゴーストスキャン・フィンガープリント
│       │   └── ssp.rs          # ゴースト起動コマンド
│       ├── utils/
│       │   └── descript.rs     # descript.txt パーサー
│       └── lib.rs              # Tauri アプリビルダー
├── e2e/                        # E2E テスト（Playwright + selenium-webdriver + tauri-driver）
│   ├── helpers/
│   │   └── harness.ts          # tauri-driver 起動・WebDriver セッション管理
│   ├── ghost-list.e2e.ts       # ゴースト一覧・検索・スクロールの E2E テスト
│   └── i18n.e2e.ts             # 言語切り替え・NFKC 正規化の E2E テスト
├── docs/
│   └── ui-guidelines.md        # UI デザインガイドライン
├── workspace/
│   └── retrospective.md        # 過去の振り返り
└── SPEC.md                     # 機能仕様書
```

## アーキテクチャ

**Tauri 2 アプリ**: Rust バックエンド + React 19 / TypeScript フロントエンド。

### バックエンド（`src-tauri/src/`）

- `lib.rs` — Tauri アプリビルダー。コマンドとプラグイン（dialog, store）を登録
- `commands/ghost/` — ゴースト一覧取得コマンド群。`scan.rs`（走査・解析）、`fingerprint.rs`（差分検知）、`path_utils.rs`（パス正規化）、`types.rs`（型定義）で構成
- `commands/ssp.rs` — `launch_ghost` コマンド。`ssp.exe /g {ghost}` を起動（SSP 内部ゴーストはディレクトリ名、外部ゴーストはフルパス）
- `utils/descript.rs` — `encoding_rs` を使い、文字コード判定付きで `descript.txt` を解析

### フロントエンド（`src/`）

- `lib/` — Tauri コマンド呼び出しラッパー・スキャンオーケストレーション・キャッシュリポジトリ・起動ロジック・設定ストア
- `hooks/` — 設定・ゴーストスキャン・検索・仮想スクロール・テーマ検出などの React カスタムフック
- `components/` — AppHeader / SettingsPanel / GhostContent / GhostList / GhostCard / SearchBox

### 横断パターン

**Tauri コマンド呼び出し**: フロントエンドは `invoke()` で camelCase の引数名を使い、Rust 側では自動的に snake_case に変換されます（例: `sspPath` → `ssp_path`, `additionalFolders` → `additional_folders`）。

**ゴーストのディレクトリ構造**: `{parent}/ghost/{ghost_name}/ghost/master/descript.txt`。`parent` は `{ssp_path}`（SSP ネイティブゴースト用）または、ゴーストサブディレクトリを直接含むユーザー指定の追加フォルダです。

**テストモック**: `vitest.config.ts` の `resolve.alias` で `@tauri-apps/*` を `src/__mocks__/` 以下のモジュールに差し替えるパターンを使用します。

**descript.txt 文字コード判定**: UTF-8 BOM → `charset` フィールド → Shift_JIS フォールバックの順で判定します（`utils/descript.rs`）。

**Rust テストの一時ディレクトリ**: テスト用の一時ディレクトリは `TempDirGuard` パターンで管理し、テスト終了時に確実に削除します。

**E2E テスト**: `playwright` + `selenium-webdriver` + `tauri-driver` を組み合わせて実機の Tauri アプリを操作します。`e2e/helpers/harness.ts` が tauri-driver の起動・WebDriver セッション確立・後片付けを担当。セレクタは日英両言語対応（XPath で `text()='起動' or text()='Launch'` のように記述）。SSP パス未設定など環境依存のテストは `test.skip()` で安全にスキップします。E2E テストはリリースビルドが前提であり CI には含まれません。

## 開発方針

- **KISS**: シンプルさを最優先する。1つの関数は1つのことだけを行い、短く保つ。到達不能なフォールバックや使われない汎用化は書かない
- **DRY**: 同一ロジックの繰り返しを避ける。ただし無理な抽象化よりも多少の重複を許容する（2回までは許容、3回目で抽出を検討）
- **SRP**: 各モジュール・関数・コンポーネントは単一の責務を持つ。複数の責務が混在したら分割する
- **YAGNI**: 現在の要件に必要なコードだけを書く。「将来必要になるかもしれない」機能・抽象化・設定項目は作らない
- **既存パターン踏襲**: 新規コードは既存のファイル構成・命名規則・スタイルパターンに合わせる。独自の新しいパターンを導入する前に既存パターンの利用を検討する
- **根本原因の修正**: バグ修正後に症状が別のテストやコードに移動した場合、根本原因に未達のサイン。「なぜ直ったか」を確認し、同一パターンのバグが他のコードパスに存在しないか検索してから修正を完了する

## 作業フロー

1. **作業内容を明確にする** — 要件や目的を確認し、不明点があればユーザーに質問する
2. **調査する** — 関連する既存コード・パターン・依存関係を調べ、影響範囲を把握する
   - 関連する関数の使用箇所を検索し、影響範囲を確認する
   - 対称的なコードパス（追加/削除、成功/失敗）がある場合は両方を確認する
   - 変更しないと判断したファイルについても、その根拠を確認する
   - `.github/workflows/ci-build.yml` を読み、変更が CI で正しく検証されるか確認する
   - Rust でファイルシステム操作を変更する場合は macOS と Windows の挙動差を考慮する（例: `entry.metadata()` は Windows FindNextFile キャッシュを参照し陳腐化する場合がある。`fs::metadata(path)` は常に最新値を返す）
3. **テストを実装する** — コード変更（機能追加・バグ修正）では、期待する振る舞いをテストコードとして先に書く（Red: テストが失敗することを確認する）。ドキュメント更新や CI 設定変更などテスト追加が不適切な作業は、理由をコミットメッセージまたは PR 説明に明記する
4. **テストがパスするように実装する** — テストを満たす最小限のコードを書く（Green: テストが通ることを確認する）
5. **検証する** — `npm run build`・`npm test`・`npm run check:ui-guidelines`・`npm run test:ui-guidelines-check`・`cargo test --manifest-path src-tauri/Cargo.toml` の全てが通ることを確認する
6. **コミットする** — 検証が完了し、実装完了 = コミット済みの状態にする。`git status` が clean になるまでセッションを終了しない
7. **PR を作成する** — CI が通ることを確認し、GitHub Flow に従い PR を作成する

## デバッグ・バグ修正の原則

- **不変条件の特定**: 修正に着手する前に、壊れているはずの不変条件を言語化する。「何が常に真でなければならないか」を明確にしてからコードを読む
- **推測の連鎖を避ける**: 最初の修正仮説が失敗したら、同じ方向に推測を重ねず、より深い調査（ログ追加・テスト追加）に切り替える
- **同一パターンの検索**: 修正前にコードベース全体を検索し、同一パターンのバグが他のコードパスに潜んでいないか確認する
- **症状の移動に注意**: 修正後に別のテストが失敗し始めた場合、根本原因に未達のサイン。症状を移動させるだけの修正は完了とみなさない

## コミット前チェックリスト

- `git status` が "nothing to commit, working tree clean" になっている
- `npm run build` が通る
- `npm test` が通る
- `npm run check:ui-guidelines` が通る
- `npm run test:ui-guidelines-check` が通る
- `cargo test --manifest-path src-tauri/Cargo.toml` が通る
- 新規テストファイルを追加した場合:
  - CI ワークフローでそのテストが実行されるか（`ci-build.yml` に test ステップが存在するか）
  - `tsconfig.json` の `exclude` に追加が必要か
  - `vitest.config.ts` の `include` が検出するか
- UI 操作・言語表示・フォーム入力に関わる変更をした場合:
  - E2E テスト（`npm run e2e`）をローカルで手動実行して動作を確認する
  - E2E テストは CI に含まれないため、手動確認が唯一の統合テスト手段

## ブランチ戦略

GitHub Flow に準拠する。

### 基本ルール

- `main` ブランチは常にデプロイ可能な状態を保つ
- すべての作業は `main` から派生したブランチで行う
- ブランチは PR マージ後に速やかに削除する
- ブランチを作成する前に `git status` が "nothing to commit, working tree clean" であることを確認する

### ブランチ命名規則

形式: `{prefix}/{issue番号}-{英語で内容の説明}`

| プレフィックス        | 用途                           | 例                                 |
|-----------------------|--------------------------------|------------------------------------|
| `feature/`            | 新機能の追加・開発             | `feature/15-ghost-folder-sorting`  |
| `fix/`                | バグ修正                       | `fix/15-validation-cancel-error`   |
| `hotfix/`             | 本番環境の緊急バグ修正         | `hotfix/16-crash-on-launch`        |
| `release/`            | リリース準備                   | `release/1.0.0`                    |
| `test/`               | テスト・実験的な作業           | `test/15-vitest-setup`             |
| `doc/` または `docs/` | ドキュメントの更新・改善       | `docs/15-update-spec`              |
| `refactor/`           | コードのリファクタリング・改善 | `refactor/15-extract-token-helper` |

番号のみのブランチ名（`fix/15`）は使わない。

### PR 運用

1. `main` から作業ブランチを作成
2. 作業単位でこまめにコミット（実装完了 = コミット済みかつ CI が通る状態）
3. `npm run build`・`npm test`・`npm run check:ui-guidelines`・`npm run test:ui-guidelines-check`・`cargo test --manifest-path src-tauri/Cargo.toml` がすべて通ることを確認してから PR を作成
4. PR マージ後にブランチを削除
5. 複数 PR を並行して進める場合: 一方が CI 失敗すると main ベースの他の PR もマージできなくなる。CI 失敗の原因が共有コード（Rust テスト等）にある場合は優先して修正 PR を立てる

## コミュニケーション方針

- **実行にバイアス**: 明確なタスクは分析・計画より実行を優先する。ユーザーが具体的な修正指示を出した場合は最小限の確認で着手する
- **コミット・PR は即実行**: コミットや PR 作成の指示は確認なしで実行する
- **分析は発見事項のみ**: 分析を求められたら発見事項のみを報告し、求められていない実装計画には踏み込まない
- **不明点は先に質問**: 着手前に不明点がある場合は、作業を始める前にまとめて質問する

## 参照ドキュメント

- `SPEC.md` — 機能仕様書。振る舞いを変更する場合は実装と同期させる
- `docs/ui-guidelines.md` — UI デザインガイドライン
- `RETROSPECTIVE.md` — 過去の振り返り（デバッグ教訓・アーキテクチャ上の学び）
  - **更新タイミング**: サイクル終了後（実装・レビュー・追加修正まで完了したとき）
  - **更新方法**: 上書き（追記しない）。前回サイクルの内容を新サイクルの振り返りで置き換える
  - **更新手順**: 新しいパターン・教訓を先に `CLAUDE.md` / `ui/CLAUDE.md` / スキルに抽出してから、`RETROSPECTIVE.md` を上書きする。抽出前に上書きすると教訓が失われる

## 言語

UI テキストはすべて日本語です。Rust ファイル内のコードコメントも日本語です。
