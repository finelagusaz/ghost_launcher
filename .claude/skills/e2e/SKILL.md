---
name: e2e
description: Playwright + tauri-driver の E2E テストをこの環境固有の設定で実行する。ユーザーが「E2E 回して」「/e2e」と言ったとき、または UI 操作・言語表示・フォーム入力に関わる変更を検証するときに使う。
disable-model-invocation: true
---

# E2E 実行ワークフロー

`playwright.tauri.config.ts` の E2E を、この環境の勘所を踏まえて実行する。E2E は CI に含まれないため、これが唯一の統合テスト手段。

E2E は識別子を差し替えた E2E 専用ビルドを起動し、利用者の本物の設定・DB に触れない（仕組みは `e2e/CLAUDE.md` が単一権威）。

## 前提

- 初回のみ: `npm run e2e:setup`（tauri-driver を導入する。EdgeDriver は実行時に `edgedriver` パッケージが取得する）。

## ステップ 1: 環境変数を添えて実行

```bash
EDGEDRIVER_VERSION='<WebView2 Runtime の pv>' npm run e2e
```

- `npm run e2e` は E2E 専用ビルド（`target/e2e/`）を作ってからテストを走らせる。アプリ本体を変えていないとき（`*.e2e.ts`・`e2e/helpers/` だけの変更）は、ビルドを省いて `npm run e2e:test` でよい。`npm run tauri build`（本番ビルド）は E2E 専用ビルドを更新しない。
- **`EDGEDRIVER_VERSION`** は WebView2 Runtime の版に合わせる。版は環境・時期で変わるため直値を覚えず、**都度レジストリの `pv` を実測**して指定する（取得元のレジストリキーは `e2e/CLAUDE.md` 参照）。
- 特定テストのみ: `npm run e2e:test -- -g "<テスト名>"`。
- 起動前のガードが「E2E 専用ビルドではありません」で止めたら、本番ビルドを指している。`GHOST_LAUNCHER_E2E_APP` を外すか、`npm run e2e:build` で作り直す。ガードを外して進めない（利用者の本物のデータを書き換える）。

## ステップ 2: 結果の解釈

- **正常水準は failed 0・skipped 0**。前提（SSP 未設定・ゴーストの有無・件数）は開始時の設定と試験用 SSP で作るため、環境によって skip されるテストは無い。skip が出たら、テストが前提を作れていない退行として扱う（`e2e/CLAUDE.md`）。
- 間欠 flake の修正検証は `--repeat-each=N` で連続 pass を確認する（単発 pass は運の可能性がある）。

## ステップ 3: 報告

passed / skipped / failed の内訳を示す。どのビルド（コミット）を検証したかと、E2E が観測していない範囲（ゴーストの起動そのもの等）を添える。
