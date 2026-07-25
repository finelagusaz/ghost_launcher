# e2e/ — E2E テスト作業規約

`playwright` + `selenium-webdriver` + `tauri-driver` を組み合わせて実機の Tauri アプリを操作します。

## 概要

- `e2e/helpers/harness.ts` が tauri-driver の起動・WebDriver セッション確立・後片付けを担当
- E2E テストはリリースビルドが前提（`npm run tauri build` 後に実行）
- **CI には含まれないため、UI 操作・言語表示・フォーム入力に関わる変更をした場合はローカルで手動実行が必須**
- **既知の失敗テストは現在ゼロ**。過去の間欠失敗は解消済み（#90 スクロール stale → #107 で `visibleGhostNames` を要素単位 try-catch にし `StaleElementReferenceError` のみ吸収／#183 ダイアログ可視性 → #191 で `openSettings` を可視性待ちに変更／#69 SearchBox placeholder → 再現しなくなりクローズ）。**したがって失敗を「既知」として片付けず、退行として扱う**。ブランチの退行か判断に迷ったら main のビルドで同一テストを実行しベースライン比較する。間欠性の判定は `--repeat-each=N` で行う（単発 pass も単発 fail も根拠にならない）

## 実行方法

```bash
# 初回セットアップ（tauri-driver と EdgeDriver を用意）
npm run e2e:setup

# テスト実行（事前に npm run tauri build が必要）
npm run e2e

# cargo workspace のためビルド出力はリポジトリ直下 target/release/ に集約される。
# harness の既定パスは src-tauri/target を指すため、GHOST_LAUNCHER_E2E_APP で明示指定する
# GHOST_LAUNCHER_E2E_APP='<repo>/target/release/ghost-launcher.exe' npm run e2e
```

**テストのみの変更は再ビルド不要**: `*.e2e.ts`（テストコード）だけの変更はアプリ本体を変えないため、直近の `target/release/` バイナリに対してそのまま実行できる（`tauri build` の再実行は不要）。間欠 flake の修正検証は `--repeat-each=N` で連続 pass を確認する（単発 pass は運の可能性があるため）。

**EdgeDriver と WebView2 Runtime のバージョン整合**: `edgedriver` パッケージは既定でシステム Edge から版を判定する。システム Edge と WebView2 Runtime の版が乖離している環境（Edge 148 だが WebView2 Runtime 147 など）では `SessionNotCreatedError` で全テストが失敗する。WebView2 Runtime の版は次のレジストリから取得できる: `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\ClientState\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` の `pv` 値。乖離時は `$env:EDGEDRIVER_VERSION = "147.0.3912.98"` のように WebView2 Runtime の版を環境変数で指定してから実行する。なお `edgedriver` の `download()` は cacheDir 内バイナリを版に関係なく返すため、harness は版指定時のみ `os.tmpdir()/edgedriver-{version}/` をバージョン別 cacheDir として渡す（`harness.ts` 参照）。

## 記述パターン

- セレクタは日英両言語対応（XPath で `text()='起動' or text()='Launch'` のように記述）
- **可視性が要る場面で `until.elementLocated` を使わない**。存在しか見ないため、Fluent UI Dialog の `<dialog>`（`open` 属性が付くまで子孫ごと `display:none`）では開くアニメーション途中の不可視要素を掴む。ダイアログを開いた後の操作・アサーションは `openSettings` の可視性待ちに委ね、呼び出し側で待ち直さない（#183。その場対処を呼び出し側に置くとヘルパー本体に還元されず、他の呼び出し側で再発する）
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
| `random-launch-button` | ランダム起動ボタン | GhostContent.tsx |
