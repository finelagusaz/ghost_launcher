---
name: e2e
description: Playwright + tauri-driver の E2E テストを正しい環境変数で実行する。ユーザーが「E2E 回して」「e2e」と言ったときに使う。この環境固有の GHOST_LAUNCHER_E2E_APP / EDGEDRIVER_VERSION の指定と、ゴースト依存テストが skip する既知要因を踏まえる。
disable-model-invocation: true
---

# E2E 実行ワークフロー

`playwright.tauri.config.ts` の E2E を、この環境の勘所を踏まえて実行する。E2E は CI に含まれないため、これが唯一の統合テスト手段。

## 前提

- 初回のみ: `npm run e2e:setup`（tauri-driver と EdgeDriver を用意）。
- 実行前に **`npm run tauri build`** が必要（E2E は release バイナリを検証する）。

## ステップ 1: ビルド

```bash
npm run tauri build
```

## ステップ 2: 必須環境変数を添えて実行

```bash
GHOST_LAUNCHER_E2E_APP='C:\workspace\ghost_launcher\target\release\ghost-launcher.exe' \
EDGEDRIVER_VERSION='<WebView2 Runtime の pv>' \
npx playwright test -c playwright.tauri.config.ts
```

- **`GHOST_LAUNCHER_E2E_APP` は必ず指定**する。cargo workspace のため `tauri build` の出力は*ワークスペース直下* `target/release/` に集約されるが、harness の `getAppBinaryPath()` 既定は `src-tauri/target/release/`（化石）を指す。override しないと古いバイナリを検証してしまう。
- **`EDGEDRIVER_VERSION`** は WebView2 Runtime の版（2026-06 時点 `149.0.4022.80`）に合わせる。レジストリの `pv` は `e2e/CLAUDE.md` 参照。
- 特定テストのみ: `-g "<テスト名>"` を付ける。

## ステップ 3: 既知の skip 要因を踏まえて結果を解釈

- ゴースト依存テスト（一覧 / 検索 / スクロール）は **harness 環境で一律 skip** する。`App.tsx` の `searchRequestKey` は初回スキャン完了（`refreshTrigger > 0`）まで `null` で、画面が「ゴーストが見つかりません」の空状態。実環境の大規模走査（Dropbox 含む複数フォルダ・1000 件超）は harness 上で `waitForGhosts`(15s) までに完了せず skip になる。
- **skip は失敗ではない**。ゴースト表示が前提のテストはこの環境では `passed` を観測できない。確実な検証はゴーストが少数で速く出る環境か、CI 外の別マシンで行う。

## ステップ 4: 報告

passed / skipped / failed の内訳を示し、skip が上記の既知要因によるものか（=失敗ではない）を明記する。
