# 開発ガイド

Ghost Launcher の開発に必要な環境構築・ビルド・テストの手順をまとめる。
利用者向けの情報（導入方法・使い方）は [README.md](../README.md) を参照。

## 技術スタック

- フロントエンド: React 19 / TypeScript / Vite
- バックエンド: Rust / Tauri 2
- ワークスペース構成: `src-tauri`（アプリ本体）+ `crates/ghost-meta`（`descript.txt` 解析クレート）

## 開発環境

- OS: Windows
- Node.js: 20 系推奨（npm は Node.js 同梱版で可）
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

# Rust バックエンドのテスト
cargo test --manifest-path src-tauri/Cargo.toml

# ghost-meta クレートのテスト
cargo test --manifest-path crates/ghost-meta/Cargo.toml

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
# 初回のみ: tauri-driver 導入 + no-bundle ビルド
npm run e2e:setup

# 実行（事前に npm run tauri build が必要）
npm run e2e
```

## CI/CD（GitHub Actions）

- `main` への push: Windows 上でビルド検証（`.github/workflows/ci-build.yml`）
- `v*` タグ push: リリースビルド実行後、GitHub Release と自動リリースノートを作成（`.github/workflows/release.yml`）

## 関連ドキュメント

- [SPEC.md](../SPEC.md) — 機能仕様書
- [docs/ui-guidelines.md](ui-guidelines.md) — UI デザインガイドライン
- [docs/locale-customization.md](locale-customization.md) — UI 文言カスタマイズ仕様
- [CLAUDE.md](../CLAUDE.md) — Claude Code 向け作業規約
