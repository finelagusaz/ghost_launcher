<div align="center">

# Ghost Launcher

**伺か/SSP ゴーストをすばやく検索・起動できるデスクトップランチャー**

[![Tauri v2](https://img.shields.io/badge/Tauri-v2-24C8D8?logo=tauri&logoColor=white)](https://tauri.app/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![Windows](https://img.shields.io/badge/Windows-0078D4?logo=windows&logoColor=white)](https://github.com/finelagusaz/ghost_launcher)

</div>

---

Ghost Launcher は、SSP/伺か用のゴーストを一覧表示し、選択したゴーストをすぐに起動できる Tauri 製ランチャーです。
SSP 本体の `ghost` フォルダに加え、任意の追加フォルダにあるゴーストもまとめて扱えます。

## ソフトの概要

- Tauri + React + TypeScript で構成されたデスクトップアプリ
- SSP フォルダを指定して、利用可能なゴーストを自動検出
- ゴースト名またはディレクトリ名で検索し、SSP を指定ゴースト付きで起動

## 主な機能

- SSP パス設定
  - `ssp.exe` を含む SSP フォルダを設定
- ゴースト一覧の自動収集
  - `SSP\ghost` 配下をスキャン
  - 追加登録したフォルダも同時にスキャン
  - `ghost/master/descript.txt` の `name`（表示名）と `craftman`（作者名）を取得して表示
- ゴースト検索
  - 表示名・ディレクトリ名の部分一致検索
  - 全角・半角の表記揺れを吸収（NFKC 正規化）
  - IME 変換中は検索をトリガーせず、確定後に実行
- 多言語対応（日本語 / English / 中文(简体) / 中文(繁體) / 한국어 / Русский）
  - 初回起動時は OS のロケールに自動追従
  - 設定パネルでいつでも切り替え可能
  - 実行ファイルと同じフォルダの `locales/{lang}.json` を置くことで UI 文言をカスタマイズ可能
- ゴースト起動
  - SSP 内ゴーストはディレクトリ名指定
  - 追加フォルダのゴーストはフルパス指定
- 設定保存
  - SSP パスと追加フォルダを `@tauri-apps/plugin-store` で保存

## 動作環境

- OS: Windows
- WebView2 ランタイム
- Microsoft Visual C++ ランタイム（`VCRUNTIME140.dll` / `VCRUNTIME140_1.dll` を含む環境）
- SSP 本体（`ssp.exe` が存在すること）

## 開発方法

### 開発環境

- OS: Windows
- Node.js: 20 系推奨
- npm: Node.js 同梱版で可
- Rust: stable
- Tauri: v2
- Tauri の前提ツール（Visual Studio C++ Build Tools など）

参考: https://tauri.app/start/prerequisites/

### 1. セットアップ

```bash
npm ci
```

### 2. 開発サーバー起動（フロントエンド）

```bash
npm run dev
```

### 3. Tauri アプリとして起動

```bash
npm run tauri dev
```

### 4. ビルド

```bash
npm run build
npm run tauri build
```

## GitHub Workflow（CI/CD）

- `main` への push: Windows 上でビルド検証（`npm run build` + `cargo check`）
- `v*` タグ push: リリースビルド実行後、GitHub Release と自動リリースノートを作成

ワークフロー定義:

- `.github/workflows/ci-build.yml`
- `.github/workflows/release.yml`

## ドキュメント

- UI デザインガイドライン: `docs/ui-guidelines.md`
- UI 文言のカスタマイズ: `docs/locale-customization.md`
