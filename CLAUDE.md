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
- `commands/ghost.rs` — `scan_ghosts` コマンド。`{ssp_path}/ghost/` と追加フォルダ内のゴーストサブディレクトリを走査し、`descript.txt` のメタデータを解析
- `commands/ssp.rs` — `launch_ghost` コマンド。`ssp.exe /g {ghost}` を起動（SSP 内部ゴーストはディレクトリ名、外部ゴーストはフルパス）
- `utils/descript.rs` — `encoding_rs` を使い、文字コード判定（UTF-8 BOM → charset フィールド → Shift_JIS フォールバック）付きで `descript.txt` を解析

### フロントエンド（`src/`）

- `hooks/useSettings.ts` — `@tauri-apps/plugin-store`（LazyStore → `settings.json`）で `ssp_path` と `ghost_folders` を永続化
- `hooks/useGhosts.ts` — Tauri の `scan_ghosts` コマンドを呼び出し、パス変更時に自動再読み込み
- `hooks/useSearch.ts` — クライアント側で name/directory_name によるゴースト絞り込み
- `components/` — SettingsPanel（フォルダ管理）、GhostList/GhostCard（表示・起動）、SearchBox

### 主要パターン

**Tauri コマンド呼び出し**: フロントエンドは `invoke()` で camelCase の引数名を使い、Rust 側では自動的に snake_case に変換されます（例: `sspPath` → `ssp_path`, `additionalFolders` → `additional_folders`）。

**ゴーストのディレクトリ構造**: `{parent}/ghost/{ghost_name}/ghost/master/descript.txt`。`parent` は `{ssp_path}`（SSP ネイティブゴースト用）または、ゴーストサブディレクトリを直接含むユーザー指定の追加フォルダです。

## 開発方針

- **KISS**: シンプルさを最優先する。1つの関数は1つのことだけを行い、短く保つ。到達不能なフォールバックや使われない汎用化は書かない
- **DRY**: 同一ロジックの繰り返しを避ける。ただし無理な抽象化よりも多少の重複を許容する（2回までは許容、3回目で抽出を検討）
- **SRP**: 各モジュール・関数・コンポーネントは単一の責務を持つ。複数の責務が混在したら分割する
- **YAGNI**: 現在の要件に必要なコードだけを書く。「将来必要になるかもしれない」機能・抽象化・設定項目は作らない
- **既存パターン踏襲**: 新規コードは既存のファイル構成・命名規則・スタイルパターンに合わせる。独自の新しいパターンを導入する前に既存パターンの利用を検討する

## 言語

UI テキストはすべて日本語です。Rust ファイル内のコードコメントも日本語です。
