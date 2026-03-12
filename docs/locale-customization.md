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
| `content.noSspPath` | SSP 未設定時のメッセージ | — |
| `content.openSettings` | 設定を開くリンク | — |
| `list.loading` | ゴーストリスト読み込み中 | — |
| `list.empty` | ゴーストが 0 件のときの表示 | — |
| `list.count` | ゴースト件数表示 | `{{count}}` |
| `card.launch` | 起動ボタン | — |
| `card.launching` | 起動中ボタン（押下後） | — |
| `card.launchError` | 起動失敗時のエラーメッセージ | `{{detail}}` |
| `search.label` | 検索ボックスのラベル | — |
| `search.placeholder` | 検索ボックスのプレースホルダ | — |

</details>

### 注意事項

- ファイルサイズの上限は **1 MB** です
- 文字コードは **UTF-8** で保存してください
- フラットなキー・バリュー形式です（ネストは不可。値は文字列のみ）
- アプリ起動後に JSON を編集した場合は、設定パネルで言語を選び直すと反映されます（同じ言語のままの場合は、一度別の言語に切り替えてから戻してください）

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
  "list.count": "{{count}} ghost(s)",
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
| `content.noSspPath` | Message shown when SSP path is not set | — |
| `content.openSettings` | Open settings link | — |
| `list.loading` | Ghost list loading state | — |
| `list.empty` | Shown when no ghosts are found | — |
| `list.count` | Ghost count display | `{{count}}` |
| `card.launch` | Launch button | — |
| `card.launching` | Launch button after clicked | — |
| `card.launchError` | Error message on launch failure | `{{detail}}` |
| `search.label` | Search box label | — |
| `search.placeholder` | Search box placeholder | — |

</details>

### Notes

- Maximum file size is **1 MB**
- Save the file in **UTF-8** encoding
- Use flat key-value pairs only (no nesting; values must be strings)
- If you edit the JSON while the app is running, re-select the language in the settings panel to apply changes (if already using that language, switch to another and back)
