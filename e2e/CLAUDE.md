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
