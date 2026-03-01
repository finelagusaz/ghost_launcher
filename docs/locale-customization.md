# UI 文言のカスタマイズ / Customizing UI Text

---

## 日本語

Ghost Launcher は、実行ファイルと同じフォルダに置いた JSON ファイルを読み込み、UI の文言を上書きできます。

### ファイルの置き場所

```
ghost_launcher.exe
locales/
  ja.json      ← 日本語 UI を上書きする場合
  en.json      ← English UI を上書きする場合
  zh-CN.json
  zh-TW.json
  ko.json
  ru.json
```

`ghost_launcher.exe` があるフォルダに `locales` フォルダを作り、対応する言語コードの JSON ファイルを置いてください。

### JSON の形式

- フラットなキー・バリュー形式（ネスト不可）
- 値は文字列のみ（数値・配列・オブジェクトは無視されます）
- **一部のキーだけ書けば OK**。省略したキーはアプリ内蔵の翻訳が使われます
- `{{変数名}}` は補間プレースホルダです。そのまま残してください

### キー一覧

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
| `settings.folders.empty` | 追加フォルダが0件のときの表示 | — |
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
| `list.empty` | ゴーストが0件のときの表示 | — |
| `list.count` | ゴースト件数表示 | `{{count}}` |
| `card.launch` | 起動ボタン | — |
| `card.launching` | 起動中ボタン（押下後） | — |
| `card.launchError` | 起動失敗時のエラーメッセージ | `{{detail}}` |
| `search.label` | 検索ボックスのラベル | — |
| `search.placeholder` | 検索ボックスのプレースホルダ | — |

### テンプレート

よく変更するキーのみ抜粋した例です。コピーして使ってください。

```json
{
  "card.launch": "起動",
  "card.launching": "起動中...",
  "list.count": "{{count}} 体のゴースト",
  "list.empty": "ゴーストが見つかりません",
  "search.placeholder": "ゴースト名で検索"
}
```

### 注意事項

- ファイルサイズの上限は **1 MB** です
- アプリ起動後に JSON を編集した場合は、アプリを再起動してください
- 文字コードは UTF-8 で保存してください

---

## English

Ghost Launcher can load a JSON file placed next to the executable to override UI text.

### File Placement

```
ghost_launcher.exe
locales/
  ja.json      ← overrides Japanese UI
  en.json      ← overrides English UI
  zh-CN.json
  zh-TW.json
  ko.json
  ru.json
```

Create a `locales` folder in the same directory as `ghost_launcher.exe` and place a JSON file named after the language code you want to override.

### JSON Format

- Flat key-value pairs (nesting is not supported)
- Values must be strings (numbers, arrays, and objects are ignored)
- **You only need to include the keys you want to change.** Omitted keys fall back to the app's built-in translations
- `{{variableName}}` are interpolation placeholders — leave them as-is

### Key Reference

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

### Template

A minimal example with commonly customized keys:

```json
{
  "card.launch": "Launch",
  "card.launching": "Launching...",
  "list.count": "{{count}} ghost(s)",
  "list.empty": "No ghosts found",
  "search.placeholder": "Search by ghost name"
}
```

### Notes

- Maximum file size is **1 MB**
- If you edit the JSON after the app has started, restart the app to apply changes
- Save the file in **UTF-8** encoding
