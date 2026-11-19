# 開発ガイド

Ghost Launcher の開発に必要な環境構築・ビルド・テストの手順をまとめる。
利用者向けの情報（導入方法・使い方）は [README.md](../README.md) を参照。

## 技術スタック

- フロントエンド: React 19 / TypeScript / Vite
- バックエンド: Rust / Tauri 2
- ワークスペース構成: `src-tauri`（アプリ本体）+ `crates/ghost-meta`（`descript.txt` 解析クレート）

## 開発環境

- OS: Windows
- Node.js: CI と同じ系列（`.github/workflows/ci-build.yml` の `node-version` が単一権威。npm は Node.js 同梱版で可）
- Rust: stable
- Tauri v2 の前提ツール（Visual Studio C++ Build Tools など）

参考: https://tauri.app/start/prerequisites/

## セットアップ

```bash
npm ci
```

## 開発サーバー

```bash
# Vite 開発サーバーと Tauri を同時起動
npm run tauri dev

# フロントエンドのみ（Vite 開発サーバー: ポート 1420）
npm run dev
```

## テスト

```bash
# フロントエンドのユニットテスト（vitest。単一ファイルは npx vitest run <path>）
npm test

# Rust のテスト（cargo workspace 全体）
cargo test --workspace

# UI ガイドライン静的チェック
npm run check:ui-guidelines
```

## ビルド

```bash
# フロントエンドのビルド
npm run build

# アプリ全体のビルド
npm run tauri build
```

## E2E テスト

```bash
# 初回のみ: tauri-driver 導入
npm run e2e:setup

# E2E 専用ビルド（識別子を差し替え、本物の設定・DB に触れない）→ テスト実行
npm run e2e
```

詳細（データ置き場の分離・試験用 SSP・WebView2 の版合わせ）は `e2e/CLAUDE.md` を参照。

## CI/CD（GitHub Actions）

- `main` 向けの pull request と `main` への push: Windows 上でビルド・テスト・lint を検証（`.github/workflows/ci-build.yml`）
- bench プロファイルのコンパイル検証（`.github/workflows/ci-bench-profile.yml`。発火条件は同ファイルを参照）
- `v*` タグ push: リリースビルド実行後、GitHub Release と自動リリースノートを作成（`.github/workflows/release.yml`）

## 関連ドキュメント

- [SPEC.md](../SPEC.md) — 機能仕様書
- [docs/ui-guidelines.md](ui-guidelines.md) — UI デザインガイドライン
- [docs/locale-customization.md](locale-customization.md) — UI 文言カスタマイズ仕様
- [CLAUDE.md](../CLAUDE.md) — Claude Code 向け作業規約
