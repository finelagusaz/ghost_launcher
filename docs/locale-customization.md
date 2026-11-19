# UI 文言のカスタマイズ / Customizing UI Text

## 日本語

Ghost Launcher の画面に表示されるテキストを、自分好みに変更できます。

### かんたん 3 ステップ

**1.** `ghost_launcher.exe` と同じフォルダに `locales` フォルダを作る

**2.** 使用中の言語に対応する JSON ファイルを作成する（例: 日本語なら `ja.json`）

```
ghost_launcher.exe
locales/
  ja.json
```

**3.** 変更したいキーだけを書く（省略したキーはアプリ内蔵の翻訳がそのまま使われます）

```json
{
  "card.launch": "起動",
  "card.launching": "起動中...",
  "list.count": "{{count}} 体のゴースト",
  "list.empty": "ゴーストが見つかりません",
  "search.placeholder": "ゴースト名で検索"
}
```

> `{{count}}` や `{{detail}}` は補間プレースホルダです。値が自動で埋め込まれるので、そのまま残してください。

### 対応言語

| ファイル名 | 言語 |
|-----------|------|
| `ja.json` | 日本語 |
| `en.json` | English |
| `zh-CN.json` | 简体中文 |
| `zh-TW.json` | 繁體中文 |
| `ko.json` | 한국어 |
| `ru.json` | Русский |

### キー一覧

<details>
<summary>すべてのキーを表示する</summary>

| キー | 用途 | 補間変数 |
|------|------|----------|
| `app.loading` | 初期読み込み中メッセージ | — |
| `app.settings.title` | 設定パネルのタイトル | — |
| `app.settings.close` | 設定を閉じるボタン | — |
| `header.refresh` | 再読込ボタン | — |
| `header.settings` | 設定ボタン | — |
| `header.randomLaunch` | ランダム起動ボタン | — |
| `header.randomLaunch.empty` | 起動可能なゴーストが無いときのメッセージ | — |
| `settings.language.label` | 言語選択ラベル | — |
| `settings.language.ja` | 日本語の表示名 | — |
| `settings.language.en` | English の表示名 | — |
| `settings.language.zh-CN` | 简体中文 の表示名 | — |
| `settings.language.zh-TW` | 繁體中文 の表示名 | — |
| `settings.language.ko` | 한국어 の表示名 | — |
| `settings.language.ru` | Русский の表示名 | — |
| `settings.ssp.label` | SSP フォルダ設定ラベル | — |
| `settings.ssp.unset` | SSP フォルダ未設定時の表示 | — |
| `settings.ssp.select` | フォルダ選択ボタン | — |
| `settings.ssp.dialogTitle` | フォルダ選択ダイアログのタイトル | — |
| `settings.folders.label` | 追加フォルダ設定ラベル | — |
| `settings.folders.add` | 追加ボタン | — |
| `settings.folders.addDialogTitle` | 追加ダイアログのタイトル | — |
| `settings.folders.empty` | 追加フォルダが 0 件のときの表示 | — |
| `settings.folders.helper` | 追加フォルダの説明文 | — |
| `settings.folders.delete` | 削除ボタン | — |
| `settings.folders.deleteAriaLabel` | 削除ボタンのアクセシビリティラベル | `{{folder}}` |
| `settings.folders.deleteConfirm` | 削除確認メッセージ | `{{folder}}` |
| `settings.folders.deleteTitle` | 削除確認ダイアログのタイトル | — |
| `settings.folders.deleteOk` | 削除確認の OK ボタン | — |
| `settings.folders.deleteCancel` | 削除確認のキャンセルボタン | — |
| `settings.folders.duplicate` | 登録済みのフォルダを追加しようとしたときの表示 | — |
| `settings.folders.sspGhostFolder` | SSP の ghost フォルダを追加しようとしたときの表示 | — |
| `settings.saveFailed` | 設定の保存に失敗したときの表示 | `{{detail}}` |
| `settings.dialogFailed` | フォルダ選択・確認のダイアログを開けなかったときの表示 | `{{detail}}` |
| `content.noSspPath` | SSP 未設定時のメッセージ | — |
| `content.openSettings` | 設定を開くリンク | — |
| `list.loading` | ゴーストリスト読み込み中 | — |
| `list.scanning` | スキャン中インジケータの aria-label | — |
| `list.empty` | ゴーストが 0 件のときの表示 | — |
| `list.emptySearch` | 検索で 0 件のときの表示 | `{{query}}` |
| `list.clearSearch` | 検索0件表示の「検索をクリア」ボタン | — |
| `list.count` | ゴースト件数表示（言語により複数形サフィックス付き。注意事項参照） | `{{count}}` |
| `card.launch` | 起動ボタン | — |
| `card.launching` | 起動中ボタン（押下後） | — |
| `card.launchError` | 起動失敗時のエラーメッセージ | `{{detail}}` |
| `card.launchSuccess` | ランダム起動成功のトースト通知 | `{{name}}` |
| `error.detail` | エラー文言の末尾に添える詳細（括弧書き） | `{{detail}}` |
| `error.scanFailed` | ゴースト一覧の取得失敗メッセージ（再読込ボタン名を `$t(header.refresh)` で参照） | `{{detail}}` |
| `error.sspExeNotFound` | 選んだフォルダに ssp.exe が無い | `{{path}}` |
| `error.sspPathNotLocal` | SSP フォルダがドライブ文字で始まるパスでない（ネットワーク共有のパス等） | `{{path}}` |
| `error.sspLaunchFailed` | SSP のプロセス起動の失敗 | `{{detail}}` |
| `error.ghostFolderNotFound` | SSP の ghost フォルダが無い | `{{path}}` |
| `error.ghostFolderNotDirectory` | SSP の ghost がフォルダでない | `{{path}}` |
| `error.ghostFolderUnreadable` | SSP の ghost フォルダを読み取れない | `{{path}}` `{{detail}}` |
| `error.ghostIdentityCollision` | 表記の違い（全角・半角、大文字・小文字など）を除くと名前が同じになるフォルダがある | `{{first}}` `{{second}}` |
| `search.label` | 検索ボックスのラベル | — |
| `search.placeholder` | 検索ボックスのプレースホルダ | — |
| `search.clear` | 検索クリア（×）ボタンの aria-label | — |
| `sort.label` | 並び替えラベル | — |
| `sort.name` | 名前順ソートの選択肢 | — |
| `sort.recent` | 最近起動した順ソートの選択肢 | — |
| `sort.frequency` | 起動回数順ソートの選択肢 | — |
| `sort.random` | ランダムソートの選択肢 | — |

</details>

### 注意事項

- ファイルサイズの上限は **1 MB** です
- 文字コードは **UTF-8** で保存してください
- フラットなキー・バリュー形式です（ネストは不可。値は文字列のみ）
- 値の中の `$t(キー)` は、そのキーの訳文に置き換わります（例: `error.scanFailed` の `$t(header.refresh)` は再読込ボタンの名前）。`header.refresh` を上書きすれば、エラー文言の中のボタン名も揃って変わります
- アプリ起動後に JSON を編集した場合は、設定パネルで言語を選び直すと反映されます（同じ言語のままの場合は、一度別の言語に切り替えてから戻してください）
- **複数形のあるキー**（現在は `list.count` のみ）: 英語の内蔵翻訳は i18next の複数形サフィックス付きキー `list.count_one` / `list.count_other` を使っています。**英語（`en.json`）で件数表示を変更する場合はこの 2 キーを上書きしてください**（`list.count` を書いても効きません）。日本語・韓国語・中国語・ロシア語の内蔵翻訳はフラットな `list.count` です。なお、ロシア語のように複数形カテゴリを持つ言語では、サフィックス付きキー（例: `list.count_one` / `list.count_few` / `list.count_many`）を追加するとフラットキーより優先され、文法的に正しい複数形を定義できます

---

## English

You can customize the text displayed in Ghost Launcher by placing a JSON file next to the executable.

### Quick Start

**1.** Create a `locales` folder in the same directory as `ghost_launcher.exe`

**2.** Create a JSON file named after the language code you want to override (e.g. `en.json` for English)

```
ghost_launcher.exe
locales/
  en.json
```

**3.** Add only the keys you want to change (omitted keys fall back to the app's built-in translations)

```json
{
  "card.launch": "Launch",
  "card.launching": "Launching...",
  "list.count_one": "{{count}} ghost",
  "list.count_other": "{{count}} ghosts",
  "list.empty": "No ghosts found",
  "search.placeholder": "Search by ghost name"
}
```

> `{{count}}` and `{{detail}}` are interpolation placeholders — values are filled in automatically, so leave them as-is.

### Supported Languages

| File name | Language |
|-----------|----------|
| `ja.json` | Japanese |
| `en.json` | English |
| `zh-CN.json` | Simplified Chinese |
| `zh-TW.json` | Traditional Chinese |
| `ko.json` | Korean |
| `ru.json` | Russian |

### Key Reference

<details>
<summary>Show all keys</summary>

| Key | Description | Variables |
|-----|-------------|-----------|
| `app.loading` | Initial loading message | — |
| `app.settings.title` | Settings panel title | — |
| `app.settings.close` | Close settings button | — |
| `header.refresh` | Refresh button | — |
| `header.settings` | Settings button | — |
| `header.randomLaunch` | Random launch button | — |
| `header.randomLaunch.empty` | Message when no ghost is available to launch | — |
| `settings.language.label` | Language selector label | — |
| `settings.language.ja` | Display name for Japanese | — |
| `settings.language.en` | Display name for English | — |
| `settings.language.zh-CN` | Display name for Simplified Chinese | — |
| `settings.language.zh-TW` | Display name for Traditional Chinese | — |
| `settings.language.ko` | Display name for Korean | — |
| `settings.language.ru` | Display name for Russian | — |
| `settings.ssp.label` | SSP folder setting label | — |
| `settings.ssp.unset` | Shown when no SSP folder is set | — |
| `settings.ssp.select` | Folder select button | — |
| `settings.ssp.dialogTitle` | Folder selection dialog title | — |
| `settings.folders.label` | Additional folders setting label | — |
| `settings.folders.add` | Add folder button | — |
| `settings.folders.addDialogTitle` | Add folder dialog title | — |
| `settings.folders.empty` | Shown when no additional folders are added | — |
| `settings.folders.helper` | Helper text for additional folders | — |
| `settings.folders.delete` | Delete button | — |
| `settings.folders.deleteAriaLabel` | Accessibility label for delete button | `{{folder}}` |
| `settings.folders.deleteConfirm` | Delete confirmation message | `{{folder}}` |
| `settings.folders.deleteTitle` | Delete confirmation dialog title | — |
| `settings.folders.deleteOk` | Confirm delete button | — |
| `settings.folders.deleteCancel` | Cancel delete button | — |
| `settings.folders.duplicate` | Shown when adding a folder that is already registered | — |
| `settings.folders.sspGhostFolder` | Shown when adding SSP's ghost folder | — |
| `settings.saveFailed` | Shown when saving the settings fails | `{{detail}}` |
| `settings.dialogFailed` | Shown when the folder picker or confirmation dialog cannot be opened | `{{detail}}` |
| `content.noSspPath` | Message shown when SSP path is not set | — |
| `content.openSettings` | Open settings link | — |
| `list.loading` | Ghost list loading state | — |
| `list.scanning` | Aria-label for scanning indicator | — |
| `list.empty` | Shown when no ghosts are found | — |
| `list.emptySearch` | Shown when a search returns no matches | `{{query}}` |
| `list.clearSearch` | "Clear search" button in the no-match state | — |
| `list.count` | Ghost count display (some languages use plural-suffixed keys; see Notes) | `{{count}}` |
| `card.launch` | Launch button | — |
| `card.launching` | Launch button after clicked | — |
| `card.launchError` | Error message on launch failure | `{{detail}}` |
| `card.launchSuccess` | Toast shown on random launch success | `{{name}}` |
| `error.detail` | Details appended to an error message (parenthesized) | `{{detail}}` |
| `error.scanFailed` | Message when loading the ghost list fails (refers to the reload button via `$t(header.refresh)`) | `{{detail}}` |
| `error.sspExeNotFound` | ssp.exe is missing from the selected folder | `{{path}}` |
| `error.sspPathNotLocal` | The SSP folder is not a path starting with a drive letter (e.g. a network share path) | `{{path}}` |
| `error.sspLaunchFailed` | Starting the SSP process failed | `{{detail}}` |
| `error.ghostFolderNotFound` | SSP's ghost folder is missing | `{{path}}` |
| `error.ghostFolderNotDirectory` | SSP's ghost is not a folder | `{{path}}` |
| `error.ghostFolderUnreadable` | SSP's ghost folder cannot be read | `{{path}}` `{{detail}}` |
| `error.ghostIdentityCollision` | Two folders have names that become identical once notation differences (width, case, etc.) are ignored | `{{first}}` `{{second}}` |
| `search.label` | Search box label | — |
| `search.placeholder` | Search box placeholder | — |
| `search.clear` | Aria-label for the clear (×) button | — |
| `sort.label` | Sort selector label | — |
| `sort.name` | Sort option: by name | — |
| `sort.recent` | Sort option: recently launched | — |
| `sort.frequency` | Sort option: most launched | — |
| `sort.random` | Sort option: random | — |

</details>

### Notes

- Maximum file size is **1 MB**
- Save the file in **UTF-8** encoding
- Use flat key-value pairs only (no nesting; values must be strings)
- `$t(key)` inside a value is replaced with that key's translation (e.g. `$t(header.refresh)` in `error.scanFailed` is the reload button's name). Overriding `header.refresh` also changes the button name inside the error message
- If you edit the JSON while the app is running, re-select the language in the settings panel to apply changes (if already using that language, switch to another and back)
- **Pluralized keys** (currently only `list.count`): the built-in English translation uses i18next plural-suffixed keys `list.count_one` / `list.count_other`. **To change the count display in English (`en.json`), override these two keys** — overriding `list.count` has no effect. The built-in Japanese, Korean, Chinese, and Russian translations use the flat `list.count` key. For languages with plural categories such as Russian, adding suffixed keys (e.g. `list.count_one` / `list.count_few` / `list.count_many`) takes precedence over the flat key and lets you define grammatically correct plurals
