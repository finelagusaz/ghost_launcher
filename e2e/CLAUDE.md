# e2e/ — E2E テスト作業規約

`playwright` + `selenium-webdriver` + `tauri-driver` を組み合わせて実機の Tauri アプリを操作します。

## 概要

- **E2E は利用者の本物のデータに触れない**。識別子を `com.ghost-launcher.e2e` に差し替えた E2E 専用ビルド（`e2e/tauri.e2e.conf.json`、出力先 `target/e2e/`）を起動する。設定・DB・ウィンドウ状態・webview の保存領域はすべて識別子でフォルダが決まるため、本番ビルド（`com.ghost-launcher.desktop`）のデータ置き場とは交わらない
- `e2e/helpers/harness.ts` が、起動前の検査（E2E 専用ビルドか）・データ置き場の初期化・tauri-driver の起動・WebDriver セッション確立・後片付けを担当
- **起動前のガード**: 起動しようとしているバイナリが E2E の識別子を含まない（本番の識別子を含む）なら起動を拒否する（`helpers/appData.ts` の `assertE2eBinary`）。`GHOST_LAUNCHER_E2E_APP` で差し替えた場合も同じ
- **テストごとに初期化**: E2E 用のデータ置き場（`%APPDATA%` と `%LOCALAPPDATA%` 配下の `com.ghost-launcher.e2e`）を消し、開始時の設定を書いてから起動する。テストが前のテストの状態（言語・DB・キャッシュ）を引き継がないため、後片付けは要らない。データ置き場を共有するため、テストは並行に走らせない（`workers: 1` は不変条件）
- **試験用 SSP**: `global-setup.ts` が実行ごとに 1 回、OS の一時ディレクトリへ作り、終了時に消す（`helpers/fixture.ts`）。本番の 1 ページ（`src/App.tsx` の `LIMIT`）を超える件数（超えていることは `global-setup.ts` が照合する）と、検索・文字コードの検証用ゴースト（ASCII 名・全角名・Shift_JIS の descript）、サムネイルの検証用ゴースト（アルファあり・キーカラー・SSP の外を指す junction・フォルダ名に日本語と記号）と、ゴースト構造の外に置いた画像（読めてはならない）を含む。`ssp.exe` は存在確認用の空ファイルで、起動ボタンは押さない
- **CI には含まれないため、UI 操作・言語表示・フォーム入力に関わる変更をした場合はローカルで手動実行が必須**
- **既知の失敗テストは無く、skip も無い**。失敗を「既知」として片付けず、退行として扱う。ブランチの退行か判断に迷ったら main のビルドで同一テストを実行しベースライン比較する。間欠性の判定は `--repeat-each=N` で行う（単発 pass も単発 fail も根拠にならない）

## 実行方法

```bash
# 初回セットアップ（tauri-driver の導入。EdgeDriver は実行時に edgedriver パッケージが取得する）
npm run e2e:setup

# E2E 専用ビルド → テスト実行（ビルドを含むため、古いバイナリを検証する取り違えが起きない）
npm run e2e

# E2E 専用ビルドだけ / テストだけ
npm run e2e:build
npm run e2e:test
```

**テストのみの変更はビルド不要**: `*.e2e.ts`・`e2e/helpers/` だけの変更はアプリ本体を変えないため、`npm run e2e:test` で直近の E2E 専用ビルドに対してそのまま実行できる。アプリ本体を変えたら `npm run e2e`（または `e2e:build` してから `e2e:test`）で作り直す。`npm run tauri build`（本番ビルド）は E2E 専用ビルドを更新しない。

**EdgeDriver と WebView2 Runtime のバージョン整合**: `edgedriver` パッケージは既定でシステム Edge から版を判定する。システム Edge と WebView2 Runtime の版が乖離している環境（Edge 148 だが WebView2 Runtime 147 など）では `SessionNotCreatedError` で全テストが失敗する。WebView2 Runtime の版は次のレジストリから取得できる: `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\ClientState\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` の `pv` 値。乖離時は `$env:EDGEDRIVER_VERSION = "147.0.3912.98"` のように WebView2 Runtime の版を環境変数で指定してから実行する。なお `edgedriver` の `download()` は cacheDir 内バイナリを版に関係なく返すため、harness は版指定時のみ `os.tmpdir()/edgedriver-{version}/` をバージョン別 cacheDir として渡す（`harness.ts` 参照）。

## 記述パターン

- セレクタは日英両言語対応（XPath で `text()='起動' or text()='Launch'` のように記述）。開始時の言語を設定で決めているテストは、その言語だけでよい
- **可視性が要る場面で `until.elementLocated` を使わない**。存在しか見ないため、Fluent UI Dialog の `<dialog>`（`open` 属性が付くまで子孫ごと `display:none`）では開くアニメーション途中の不可視要素を掴む。ダイアログを開いた後の操作・アサーションは `openSettings` の可視性待ちに委ね、呼び出し側で待ち直さない（#183。その場対処を呼び出し側に置くとヘルパー本体に還元されず、他の呼び出し側で再発する）
- **`test.skip()` で環境依存を逃がさない**。前提（SSP 未設定・ゴーストの有無・件数）は開始時の設定と試験用 SSP で作る。前提が満たされないときに skip したり、条件分岐でアサーションを飛ばしたりすると、検証していないのに通ったように見える
- SSP が未設定（`settings: null`）だと、アプリは起動時に設定ダイアログを自動で開く。`openSettings` で開き直さない

## テスト追加の手順

1. `e2e/` に `*.e2e.ts` ファイルを作成（`ghost-list.e2e.ts` をテンプレートにする）
2. `helpers/test.ts` の `test` と `expect` を使う（harness フィクスチャがテストごとにデータ置き場を初期化して起動する）。開始時の設定は `test.use({ settings: ... })` で選ぶ（既定: 試験用 SSP を設定した日本語の状態、`null`: 設定ファイルなしの初回起動）
3. `helpers/ui.ts` のヘルパーを使う: `waitForAppReady`（初期ロード待機）、`waitForGhosts`（スキャン完了待機。現れなければ失敗する）、`searchAndWait`（検索して結果を待つ）、`visibleGhostNames`、`openSettings`/`closeSettings`
4. 要素取得は `data-testid` 属性を優先（`By.css("[data-testid='...']")`）。期待するゴーストは `helpers/fixture.ts` の定数（`SPECIAL_GHOSTS`・`FIXTURE_GHOST_TOTAL`）で名指しする
5. 追加したテストは、前提を崩すと落ちることを一度確かめる（落ちないテストは、通るテストと区別がつかない）

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
| `thumbnail-overlay` | ホバー時のサムネイル表示（`<img>` か `<canvas>` を含む） | GhostCard.tsx |
