<div align="center">

# Ghost Launcher

**伺か/SSP のゴーストを、すばやく探して呼び出せるランチャー**

[![Latest Release](https://img.shields.io/github/v/release/finelagusaz/ghost_launcher)](https://github.com/finelagusaz/ghost_launcher/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-0078D4?logo=windows&logoColor=white)](https://github.com/finelagusaz/ghost_launcher/releases/latest)
[![License: MIT](https://img.shields.io/github/license/finelagusaz/ghost_launcher)](LICENSE)

</div>

---

ゴーストが増えてくると、SSP のメニューから目当ての一体を探し出すのはなかなか骨が折れるもの。
Ghost Launcher は、手持ちのゴーストをずらりと一覧にして、名前を数文字打つだけでデスクトップに立たせられるランチャーです。

- ゴーストが増えすぎて、切り替えメニューを延々スクロールするのがつらい
- 名前はうろ覚えでも、検索でさっと見つけたい
- 「今日は誰と過ごそうかな」を運まかせにしたい

そんなときのお供にどうぞ。

## 特徴

- **すばやい検索** — ゴースト名・作者名の部分一致で検索。全角/半角の表記揺れも吸収します。IME 変換中に検索が走らないので、日本語入力も快適です
- **キーボードだけで起動** — 起動直後から検索欄に入力でき、`↑` `↓` で選んで `Enter` を押すだけ。マウスいらずです
- **ソート & ランダム起動** — 名前順・最近起動順・起動回数順・ランダム順を切り替え。迷った日はランダム起動ボタンにおまかせを
- **SSP の外のゴーストもまとめて** — SSP フォルダに加えて、お好きなフォルダを登録して一緒に一覧化できます
- **たくさん居ても軽快** — スキャン結果をキャッシュし、変化した分だけ読み直します
- **多言語 UI** — 日本語 / English / 中文(简体) / 中文(繁體) / 한국어 / Русский。初回は OS の言語に自動で合わせます
- **ライト/ダークテーマ** — OS のテーマ設定に自動追従します

## 動作環境

- Windows
- [SSP](https://ssp.shillest.net/)（ゴーストの起動に `ssp.exe` を使います）
- WebView2 ランタイム
- Microsoft Visual C++ ランタイム（`VCRUNTIME140.dll` / `VCRUNTIME140_1.dll` を含む環境）

## インストール

1. [Releases](https://github.com/finelagusaz/ghost_launcher/releases/latest) から `ghost-launcher-*-windows-x64.zip` をダウンロード
2. お好きな場所に展開
3. `ghost-launcher.exe` を起動

インストーラー形式ではなく、zip を展開するだけで使えます。

## 使い方

### はじめての設定

1. 画面右上の「設定」を開く
2. 「SSP フォルダ」に `ssp.exe` のあるフォルダを指定する
3. ゴーストが自動で一覧に並びます

SSP のフォルダ以外にもゴーストを置いている場合は、設定の「追加ゴーストフォルダ」に登録すると一緒に一覧へ加わります。

### ゴーストを探して起動する

Ghost Launcher を開いた瞬間から、検索欄に文字を打てます。

| 操作 | 動作 |
| ---- | ---- |
| 文字入力 | 検索（先頭の候補が自動で選ばれます） |
| `↑` / `↓` | 候補の移動 |
| `Enter` | 選択中のゴーストを起動 |
| `Esc` | 検索をクリア |

マウス派の方は、一覧のカードにある「起動」ボタンをどうぞ。

## カスタマイズ

UI の文言はお好みに書き換えられます。実行ファイルと同じフォルダに `locales/ja.json` のような言語別 JSON を置いてください。
詳しくは [docs/locale-customization.md](docs/locale-customization.md) をどうぞ。

## 開発者向け情報

ビルド方法・テスト・CI などの開発情報は [docs/development.md](docs/development.md) にまとめています。
機能仕様は [SPEC.md](SPEC.md) を参照してください。

## ライセンス

[MIT License](LICENSE)
