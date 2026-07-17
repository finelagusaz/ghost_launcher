---
name: e2e
description: Playwright + tauri-driver の E2E テストをこの環境固有の設定で実行する。ユーザーが「E2E 回して」「/e2e」と言ったとき、または UI 操作・言語表示・フォーム入力に関わる変更を検証するときに使う。
disable-model-invocation: true
---

# E2E 実行ワークフロー

`playwright.tauri.config.ts` の E2E を、この環境の勘所を踏まえて実行する。E2E は CI に含まれないため、これが唯一の統合テスト手段。

## 前提

- 初回のみ: `npm run e2e:setup`（tauri-driver を導入し no-bundle ビルドを実行。EdgeDriver は実行時に `edgedriver` パッケージが取得する）。
- 実行前に **`npm run tauri build`** が必要（E2E は release バイナリを検証する）。

## ステップ 1: ビルド（アプリ本体に変更がある場合のみ）

```bash
npm run tauri build
```

テストコード（`*.e2e.ts`）のみの変更はアプリ本体を変えないため**再ビルド不要**。直近の `target/release/` バイナリに対してそのまま実行してよい。

## ステップ 2: 必須環境変数を添えて実行

```bash
GHOST_LAUNCHER_E2E_APP='C:\workspace\ghost_launcher\target\release\ghost-launcher.exe' \
EDGEDRIVER_VERSION='<WebView2 Runtime の pv>' \
npx playwright test -c playwright.tauri.config.ts
```

- **`GHOST_LAUNCHER_E2E_APP` は必ず指定**する。cargo workspace のため `tauri build` の出力は*ワークスペース直下* `target/release/` に集約されるが、harness の `getAppBinaryPath()` 既定は `src-tauri/target/release/`（化石）を指す。override しないと古いバイナリを検証してしまう。
- **`EDGEDRIVER_VERSION`** は WebView2 Runtime の版に合わせる。版は環境・時期で変わるため直値を覚えず、**都度レジストリの `pv` を実測**して指定する（取得元のレジストリキーは `e2e/CLAUDE.md` 参照）。
- 特定テストのみ: `-g "<テスト名>"` を付ける。

## ステップ 3: 結果の解釈

- **正常水準は 10 passed / 1 skipped**（11 テスト中、2026-07-17 実測。ポート一意化 #154 後に連続クリーンを確認済み）。skip は SSP 設定済み環境では観測できない「SSP 未設定時の空状態」テスト（`i18n.e2e.ts`）で正当。
- ゴースト依存テスト（一覧 / 検索 / スクロール）は fingerprint キャッシュが冷えている環境では初回スキャンが `waitForGhosts`(15s) に間に合わず skip しうる。**skip は失敗ではない**が、passed が観測できないときはキャッシュが温まった 2 回目の実行で確認する。
- 間欠 flake の修正検証は `--repeat-each=N` で連続 pass を確認する（単発 pass は運の可能性がある）。

## ステップ 4: 報告

passed / skipped / failed の内訳を示し、skip が上記の既知要因によるものか（=失敗ではない）を明記する。
