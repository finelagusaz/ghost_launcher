# e2e/ — E2E テスト作業規約

`playwright` + `selenium-webdriver` + `tauri-driver` を組み合わせて実機の Tauri アプリを操作します。

## 概要

- `e2e/helpers/harness.ts` が tauri-driver の起動・WebDriver セッション確立・後片付けを担当
- E2E テストはリリースビルドが前提（`npm run tauri build` 後に実行）
- **CI には含まれないため、UI 操作・言語表示・フォーム入力に関わる変更をした場合はローカルで手動実行が必須**

## 実行方法

```bash
# 初回セットアップ（tauri-driver と EdgeDriver を用意）
npm run e2e:setup

# テスト実行（事前に npm run tauri build が必要）
npm run e2e
```

## 記述パターン

- セレクタは日英両言語対応（XPath で `text()='起動' or text()='Launch'` のように記述）
- SSP パス未設定など環境依存のテストは `test.skip()` で安全にスキップ

## テスト追加の手順

1. `e2e/` に `*.e2e.ts` ファイルを作成（`ghost-list.e2e.ts` をテンプレートにする）
2. `base.extend<{ harness: Harness }>` で harness フィクスチャを定義し、`createHarness`/`disposeHarness` でセッションを管理
3. `helpers/ui.ts` のヘルパーを使う: `waitForAppReady`（初期ロード待機）、`waitForGhosts`（スキャン完了待機）、`openSettings`/`closeSettings`
4. 要素取得は `data-testid` 属性を優先（`By.css("[data-testid='...']")`）。テキストマッチが必要な場合は XPath で日英両方を記述

## 主要な data-testid 一覧

| testid | 要素 | ファイル |
|--------|------|----------|
| `settings-button` | ヘッダー設定ボタン | AppHeader.tsx |
| `open-settings-button` | 空状態の設定誘導ボタン | GhostContent.tsx |
| `settings-close-button` | 設定ダイアログ閉じるボタン | App.tsx |
| `launch-button` | ゴースト起動ボタン | GhostCard.tsx |
| `ghost-name` | ゴースト名テキスト | GhostCard.tsx |
| `ghost-list-viewport` | 仮想スクロールコンテナ | GhostList.tsx |
| `empty-state` | 空状態メッセージ | GhostList.tsx / GhostContent.tsx |
| `random-launch-button` | ランダム起動ボタン | AppHeader.tsx |
