# Ghost Launcher

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
  - `ghost/master/descript.txt` の `name` を表示名として利用
- ゴースト検索
  - 表示名・ディレクトリ名の部分一致検索
- ゴースト起動
  - SSP 内ゴーストはディレクトリ名指定
  - 追加フォルダのゴーストはフルパス指定
- 設定保存
  - SSP パスと追加フォルダを `@tauri-apps/plugin-store` で保存

## 動作環境

- OS: Windows（`ssp.exe` 起動前提のため）
- Node.js: 20 系推奨
- npm: Node.js 同梱版で可
- Rust: stable
- Tauri: v2

開発前に Tauri の前提ツール（Visual Studio C++ Build Tools など）をセットアップしてください。  
参考: https://tauri.app/start/prerequisites/

## 開発方法

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
