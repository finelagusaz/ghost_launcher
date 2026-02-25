# CLAUDE.md

このファイルは、このリポジトリでコード作業を行う際の Claude Code（claude.ai/code）向けガイドです。

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

# アプリ全体をビルド
npm run tauri build
```

## アーキテクチャ

**Tauri 2 アプリ**: Rust バックエンド + React 19 / TypeScript フロントエンド。

### バックエンド（`src-tauri/src/`）

- `lib.rs` — Tauri アプリビルダー。コマンドとプラグイン（dialog, store）を登録
- `commands/ghost/` — ゴースト関連コマンド群（モジュール分割構成）
  - `mod.rs` — `scan_ghosts_with_meta`・`get_ghosts_fingerprint` コマンドを公開
  - `scan.rs` — `scan_ghosts_internal`。`{ssp_path}/ghost/` と追加フォルダ内のゴーストサブディレクトリを走査し、`descript.txt` のメタデータを解析
  - `fingerprint.rs` — ゴーストディレクトリ構成からフィンガープリント文字列を生成（差分検知用）
  - `path_utils.rs` — パス正規化ユーティリティ
  - `types.rs` — `Ghost`・`ScanGhostsResponse` 型定義
- `commands/ssp.rs` — `launch_ghost` コマンド。`ssp.exe /g {ghost}` を起動（SSP 内部ゴーストはディレクトリ名、外部ゴーストはフルパス）
- `utils/descript.rs` — `encoding_rs` を使い、文字コード判定（UTF-8 BOM → charset フィールド → Shift_JIS フォールバック）付きで `descript.txt` を解析

### フロントエンド（`src/`）

- `lib/` — Tauri コマンド呼び出し・ビジネスロジック
  - `ghostScanClient.ts` — `scan_ghosts_with_meta`・`get_ghosts_fingerprint` の invoke ラッパー
  - `ghostScanOrchestrator.ts` — スキャン＋キャッシュ更新のオーケストレーション
  - `ghostScanUtils.ts` — スキャン結果の加工ユーティリティ
  - `ghostCacheRepository.ts` — ゴーストキャッシュの永続化（LazyStore）
  - `ghostLaunchUtils.ts` — ゴースト起動ロジック
  - `settingsStore.ts` — `@tauri-apps/plugin-store`（LazyStore → `settings.json`）の設定読み書き
- `hooks/` — React カスタムフック
  - `useSettings.ts` — 設定の読み込み・更新（`ssp_path`, `ghost_folders`）
  - `useGhosts.ts` — ゴーストスキャン・キャッシュ管理。パス変更時に自動再読み込み
  - `useSearch.ts` — クライアント側で name/directory_name によるゴースト絞り込み
  - `useVirtualizedList.ts` — 仮想スクロール計算（startIndex/endIndex/spacer）
  - `useElementHeight.ts` — ResizeObserver による要素高さの追跡
  - `useSystemTheme.ts` — OS テーマ（light/dark）検出
- `components/` — React コンポーネント
  - `AppHeader.tsx` — アプリヘッダー（タイトル・設定ボタン）
  - `SettingsPanel.tsx` — フォルダ管理パネル
  - `GhostContent.tsx` — ゴースト一覧エリアのコンテナ
  - `GhostList.tsx` — ゴーストリスト（仮想スクロール対応）
  - `GhostCard.tsx` — 個別ゴーストの表示・起動カード
  - `SearchBox.tsx` — 検索ボックス

### 主要パターン

**Tauri コマンド呼び出し**: フロントエンドは `invoke()` で camelCase の引数名を使い、Rust 側では自動的に snake_case に変換されます（例: `sspPath` → `ssp_path`, `additionalFolders` → `additional_folders`）。

**ゴーストのディレクトリ構造**: `{parent}/ghost/{ghost_name}/ghost/master/descript.txt`。`parent` は `{ssp_path}`（SSP ネイティブゴースト用）または、ゴーストサブディレクトリを直接含むユーザー指定の追加フォルダです。

## 開発方針

- **KISS**: シンプルさを最優先する。1つの関数は1つのことだけを行い、短く保つ。到達不能なフォールバックや使われない汎用化は書かない
- **DRY**: 同一ロジックの繰り返しを避ける。ただし無理な抽象化よりも多少の重複を許容する（2回までは許容、3回目で抽出を検討）
- **SRP**: 各モジュール・関数・コンポーネントは単一の責務を持つ。複数の責務が混在したら分割する
- **YAGNI**: 現在の要件に必要なコードだけを書く。「将来必要になるかもしれない」機能・抽象化・設定項目は作らない
- **既存パターン踏襲**: 新規コードは既存のファイル構成・命名規則・スタイルパターンに合わせる。独自の新しいパターンを導入する前に既存パターンの利用を検討する

## 作業フロー

1. **作業内容を明確にする** — 要件や目的を確認し、不明点があればユーザーに質問する
2. **調査する** — 関連する既存コード・パターン・依存関係を調べ、影響範囲を把握する。`.github/workflows/ci-build.yml` を読み、変更が CI で正しく検証されるか確認する
3. **テストを実装する** — 期待する振る舞いをテストコードとして先に書く
4. **テストがパスするように実装する** — テストを満たす最小限のコードを書く
5. **コミットする** — 実装完了 = コミット済み。`git status` が clean になるまでセッションを終了しない
6. **検証する** — `npm run build`・`npm test`・`cargo test` の全てが通ることを確認する
7. **PR を作成する** — CI が通ることを確認し、GitHub Flow に従い PR を作成する

## コミット前チェックリスト

- `git status` が "nothing to commit, working tree clean" になっている
- `npm run build` が通る
- `npm test` が通る（テストがある場合）
- `cargo test` が通る（Rust を変更した場合）
- 新規テストファイルを追加した場合:
  - CI ワークフローでそのテストが実行されるか（`ci-build.yml` に test ステップが存在するか）
  - `tsconfig.json` の `exclude` に追加が必要か
  - `vitest.config.ts` の `include` が検出するか

## ブランチ戦略

GitHub Flow に準拠する。

### 基本ルール

- `main` ブランチは常にデプロイ可能な状態を保つ
- すべての作業は `main` から派生したブランチで行う
- ブランチは PR マージ後に速やかに削除する
- ブランチを作成する前に `git status` が "nothing to commit, working tree clean" であることを確認する

### ブランチ命名規則

形式: `{prefix}/{issue番号}-{英語で内容の説明}`

| プレフィックス | 用途 | 例 |
|---|---|---|
| `feature/` | 新機能の追加・開発 | `feature/15-ghost-folder-sorting` |
| `fix/` | バグ修正 | `fix/15-validation-cancel-error` |
| `hotfix/` | 本番環境の緊急バグ修正 | `hotfix/16-crash-on-launch` |
| `release/` | リリース準備 | `release/1.0.0` |
| `test/` | テスト・実験的な作業 | `test/15-vitest-setup` |
| `doc/` または `docs/` | ドキュメントの更新・改善 | `docs/15-update-spec` |
| `refactor/` | コードのリファクタリング・改善 | `refactor/15-extract-token-helper` |

番号のみのブランチ名（`fix/15`）は使わない。

### PR 運用

1. `main` から作業ブランチを作成
2. 作業単位でこまめにコミット（実装完了 = コミット済みかつ CI が通る状態）
3. `npm run build`・`npm test`・`cargo test` がすべて通ることを確認してから PR を作成
4. PR マージ後にブランチを削除

## 言語

UI テキストはすべて日本語です。Rust ファイル内のコードコメントも日本語です。
