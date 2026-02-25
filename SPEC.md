# Ghost Launcher 仕様書

## 1. プロジェクト概要

Ghost Launcher は、**伺か/SSP ゴースト**を検出・一覧表示・検索・起動するための Windows 向けデスクトップランチャーアプリケーションである。

- **対象ユーザー**: 伺か/SSP を利用しているユーザー
- **動作環境**: Windows（WebView2 ランタイム + VC++ ランタイム + SSP 本体が必要）
- **技術構成**: Tauri 2（Rust バックエンド）+ React 19 / TypeScript フロントエンド + Fluent UI v9

---

## 2. 機能一覧

| ID | 機能名 | 概要 |
|----|--------|------|
| F-01 | SSP フォルダ設定 | `ssp.exe` を含むフォルダをダイアログで選択・永続化 |
| F-02 | 追加フォルダ管理 | SSP 外のゴーストフォルダを追加・削除・永続化 |
| F-03 | ゴーストスキャン | SSP フォルダ + 追加フォルダ内のゴーストを走査し `descript.txt` からメタデータを解析 |
| F-04 | フィンガープリント差分検知 | ディレクトリ構成・更新時刻のハッシュでスキャン結果の変化を検出 |
| F-05 | ゴーストキャッシュ | スキャン結果を `settings.json`（LazyStore）に永続化し、次回起動時に即時表示 |
| F-06 | ゴースト検索 | 名前・ディレクトリ名の部分一致によるクライアントサイドフィルタリング |
| F-07 | ゴースト起動 | SSP を `/g` オプション付きで起動（SSP 内: ディレクトリ名、外部: フルパス指定） |
| F-08 | 仮想スクロール | 80件以上のゴーストリスト描画を仮想化で最適化 |
| F-09 | テーマ追従 | OS のライト/ダークテーマに自動追従（Fluent UI） |
| F-10 | ウィンドウ状態保存 | `tauri-plugin-window-state` によるウィンドウ位置・サイズの永続化 |

---

## 3. アーキテクチャ

### 3.1 全体構成

```
┌──────────────────────────────────────────────────────┐
│                    Tauri Shell                        │
│  ┌─────────────────────┐  ┌────────────────────────┐ │
│  │  Rust バックエンド    │  │  React フロントエンド    │ │
│  │                     │  │                        │ │
│  │  commands/           │  │  App.tsx               │ │
│  │   ghost/            │◄─┤   hooks/               │ │
│  │     scan.rs         │  │   lib/                 │ │
│  │     fingerprint.rs  │  │   components/          │ │
│  │   ssp.rs            │  │                        │ │
│  │  utils/             │  │  Fluent UI v9          │ │
│  │   descript.rs       │  │  @tauri-apps/api       │ │
│  └─────────────────────┘  └────────────────────────┘ │
│                                                      │
│  Plugins: dialog, store, window-state                │
└──────────────────────────────────────────────────────┘
         │                           │
         ▼                           ▼
   ファイルシステム              settings.json
   (ghost/ ディレクトリ)        (LazyStore 永続化)
```

### 3.2 バックエンド（Rust）モジュール構成

| ファイル | 責務 |
|---------|------|
| `lib.rs` | Tauri アプリビルダー。コマンド・プラグイン登録 |
| `main.rs` | エントリポイント（`ghost_launcher_lib::run()` 呼び出し） |
| `commands/ghost/mod.rs` | `scan_ghosts_with_meta`・`get_ghosts_fingerprint` Tauri コマンド公開 |
| `commands/ghost/scan.rs` | ゴーストディレクトリ走査＋フィンガープリントトークン同時収集 |
| `commands/ghost/fingerprint.rs` | フィンガープリント専用計算（`build_fingerprint`）＋ハッシュ生成 |
| `commands/ghost/path_utils.rs` | パス正規化（`\` → `/`、小文字化） |
| `commands/ghost/types.rs` | `Ghost`・`ScanGhostsResponse` 型定義 |
| `commands/ssp.rs` | `launch_ghost` コマンド（`ssp.exe /g {ghost}` を起動） |
| `utils/descript.rs` | `descript.txt` パーサー（UTF-8 BOM / charset フィールド / Shift_JIS フォールバック） |

### 3.3 フロントエンド（React/TypeScript）モジュール構成

| ファイル | 責務 |
|---------|------|
| `main.tsx` | ルートレンダリング。FluentProvider でテーマ設定 |
| `App.tsx` | アプリ全体のレイアウト・状態管理の統合 |
| `types/index.ts` | 共有型定義（`Ghost`, `GhostView`, `ScanGhostsResponse`, キャッシュ型） |
| **lib/** | |
| `settingsStore.ts` | `LazyStore("settings.json")` のシングルトン |
| `ghostScanClient.ts` | Tauri `invoke` ラッパー（`scanGhostsWithMeta`, `getGhostsFingerprint`） |
| `ghostScanOrchestrator.ts` | キャッシュ検証・重複排除付きスキャン実行 |
| `ghostScanUtils.ts` | パス正規化・リクエストキー生成・エラーメッセージ構築 |
| `ghostCacheRepository.ts` | ゴーストキャッシュの読み書き（キュー化による直列書き込み） |
| `ghostLaunchUtils.ts` | 起動エラーメッセージ構築・ソースフォルダラベル取得 |
| **hooks/** | |
| `useSettings.ts` | 設定（`ssp_path`, `ghost_folders`）の読み込み・更新・永続化 |
| `useGhosts.ts` | ゴーストスキャン・キャッシュ管理・状態提供 |
| `useSearch.ts` | `name` / `directory_name` による部分一致フィルタ |
| `useVirtualizedList.ts` | 仮想スクロール計算（startIndex/endIndex/spacer） |
| `useElementHeight.ts` | ResizeObserver による要素高さ追跡 |
| `useSystemTheme.ts` | OS テーマ（light/dark）検出・追従 |
| **components/** | |
| `AppHeader.tsx` | タイトル・再読込ボタン・設定ボタン |
| `SettingsPanel.tsx` | SSP フォルダ選択・追加フォルダ管理 UI |
| `GhostContent.tsx` | ゴースト一覧エリア（検索ボックス + リスト）のコンテナ |
| `GhostList.tsx` | ゴーストリスト表示（仮想スクロール対応・状態分岐） |
| `GhostCard.tsx` | 個別ゴースト表示カード（名前・ディレクトリ名・ソースバッジ・起動ボタン） |
| `SearchBox.tsx` | 検索入力フィールド |

---

## 4. データモデル

### 4.1 Ghost（Rust / TypeScript 共通）

| フィールド | 型 | 説明 |
|-----------|----|------|
| `name` | `String` | `descript.txt` の `name` フィールド（未定義時はディレクトリ名にフォールバック） |
| `directory_name` | `String` | ゴーストのディレクトリ名 |
| `path` | `String` | ゴーストのフルパス |
| `source` | `String` | `"ssp"`（SSP 内ゴースト）またはフォルダのフルパス（追加フォルダ） |

### 4.2 GhostView（フロントエンド拡張）

`Ghost` に加えて以下を持つ:

| フィールド | 型 | 説明 |
|-----------|----|------|
| `name_lower` | `string` | `name` の小文字版（検索用） |
| `directory_name_lower` | `string` | `directory_name` の小文字版（検索用） |

### 4.3 GhostCacheStoreV1（永続化キャッシュ）

```json
{
  "version": 1,
  "entries": {
    "<request_key>": {
      "request_key": "c:/ssp::c:/extra_ghosts",
      "fingerprint": "0123456789abcdef",
      "ghosts": [ /* Ghost[] */ ],
      "cached_at": "2026-02-24T12:00:00.000Z"
    }
  }
}
```

### 4.4 設定ストア（settings.json）

| キー | 型 | 説明 |
|------|----|------|
| `ssp_path` | `string` | SSP インストールフォルダパス |
| `ghost_folders` | `string[]` | 追加ゴーストフォルダの配列 |
| `ghost_cache_v1` | `GhostCacheStoreV1` | ゴーストキャッシュ |

---

## 5. ゴーストディレクトリ構造

ゴーストは以下の規則に従って検出される:

```
{parent}/
  {ghost_name}/          ← ゴーストディレクトリ（directory_name）
    ghost/
      master/
        descript.txt     ← メタデータファイル
```

- **SSP 内ゴースト**: `{ssp_path}/ghost/{ghost_name}/ghost/master/descript.txt`
- **追加フォルダのゴースト**: `{additional_folder}/{ghost_name}/ghost/master/descript.txt`

### 5.1 descript.txt の解析

- **フォーマット**: CSV ライク（`key,value` のカンマ区切り、1行1エントリ）
- **コメント**: `//` で始まる行は無視
- **空行**: 無視
- **文字コード判定順序**:
  1. UTF-8 BOM（`0xEF 0xBB 0xBF`）→ UTF-8
  2. 先頭 4096 バイト内の `charset` フィールド → 指定コードで全体デコード
  3. フォールバック → Shift_JIS

---

## 6. Tauri コマンド仕様

### 6.1 `scan_ghosts_with_meta`

| 項目 | 内容 |
|------|------|
| 引数 | `ssp_path: String`, `additional_folders: Vec<String>` |
| 戻り値 | `ScanGhostsResponse { ghosts: Vec<Ghost>, fingerprint: String }` |
| 処理 | SSP の `ghost/` ディレクトリと追加フォルダを走査し、ゴースト一覧とフィンガープリントを同時に返す |
| ソート | `name` の大文字小文字無視の辞書順 |
| エラー | SSP の `ghost/` フォルダ不在時にエラー。追加フォルダの不在・読取不能は無視して続行 |

### 6.2 `get_ghosts_fingerprint`

| 項目 | 内容 |
|------|------|
| 引数 | `ssp_path: String`, `additional_folders: Vec<String>` |
| 戻り値 | `String`（64桁16進数ハッシュ、SHA-256） |
| 処理 | ゴーストディレクトリ構成の変化検知用フィンガープリントを返す。ゴースト内容は読まず、ディレクトリとファイルの存在・更新時刻のみで計算 |

### 6.3 `launch_ghost`

| 項目 | 内容 |
|------|------|
| 引数 | `ssp_path: String`, `ghost_directory_name: String`, `ghost_source: String` |
| 戻り値 | `()` |
| 処理 | `ssp.exe /g {ghost_arg}` を起動。SSP 内ゴースト（`source == "ssp"`）はディレクトリ名のみ、外部ゴーストは `{source}/{directory_name}` のフルパスを渡す |
| エラー | `ssp.exe` 不在時・起動失敗時にエラー |

---

## 7. フィンガープリント仕様

### 7.1 トークン構成

フィンガープリントは以下のトークン文字列の集合から計算される:

| トークン形式 | 説明 |
|-------------|------|
| `fingerprint-version\|1` | バージョンヘッダ |
| `parent\|{label}\|{normalized_path}\|{modified_nanos}` | 親ディレクトリの更新時刻 |
| `parent\|{label}\|{normalized_path}\|missing` | 存在しない追加フォルダ |
| `parent\|{label}\|{normalized_path}\|not-directory` | ディレクトリでない追加フォルダ |
| `entries\|{label}\|{normalized_path}\|unreadable` | 読取不能なディレクトリ |
| `entry\|{label}\|{normalized_path}\|{dir_name}\|{dir_modified}\|{descript_state}\|{descript_modified}` | 個別ゴーストエントリ |

### 7.2 ハッシュ計算

1. 全トークンをソート
2. SHA-256 でトークンを順番に update（トークン間に `\n` を挿入して境界混同を防止）
3. 64桁16進数文字列（SHA-256）として出力

### 7.3 追加フォルダの正規化

- パスの `\` を `/` に統一し小文字化
- 重複排除後、正規化パスの辞書順でソート（順序非依存性を保証）

---

## 8. キャッシュ戦略

### 8.1 キャッシュフロー

1. **起動時**: `settings.json` から `ghost_cache_v1` を一括読み込み（`useSettings` の `initialGhostCache`）
2. **表示**: キャッシュが存在すれば即時表示（ローディング表示をスキップ）
3. **検証**: バックグラウンドで `get_ghosts_fingerprint` を呼び出し、キャッシュの fingerprint と比較
4. **一致**: スキャン不要（キャッシュをそのまま利用）
5. **不一致/エラー**: フルスキャンを実行し、結果で上書き
6. **書き込み**: キャッシュ書き込みは fire-and-forget（UI 更新をブロックしない）、キュー化で直列実行

### 8.2 強制リフレッシュ

ヘッダーの「再読込」ボタンはキャッシュ検証をスキップし、即座にフルスキャンを実行する。

### 8.3 重複排除

同一 `requestKey` に対する並行スキャンリクエストは共有される（`pendingScans` Map）。

---

## 9. 状態遷移図

### 9.1 アプリケーション全体の状態遷移

```mermaid
stateDiagram-v2
    [*] --> SettingsLoading : アプリ起動

    SettingsLoading --> NoSspPath : SSP パス未設定
    SettingsLoading --> GhostScanFlow : SSP パス設定済み

    NoSspPath --> SettingsDialogOpen : 自動的に設定ダイアログ表示
    SettingsDialogOpen --> GhostScanFlow : SSP パス保存

    state GhostScanFlow {
        [*] --> CheckCache

        CheckCache --> ShowCachedGhosts : キャッシュあり
        CheckCache --> FullScan : キャッシュなし

        ShowCachedGhosts --> ValidateFingerprint : バックグラウンド検証
        ValidateFingerprint --> Ready : 一致（変更なし）
        ValidateFingerprint --> FullScan : 不一致（変更あり）

        FullScan --> Ready : スキャン成功
        FullScan --> ScanError : スキャン失敗

        ScanError --> FullScan : 再読込
    }

    GhostScanFlow --> Ready

    state Ready {
        [*] --> GhostListDisplayed
        GhostListDisplayed --> FilteredList : 検索入力
        FilteredList --> GhostListDisplayed : 検索クリア
    }

    Ready --> GhostScanFlow : 再読込ボタン押下
    Ready --> GhostScanFlow : 設定変更（パス/フォルダ）
    Ready --> LaunchGhost : 起動ボタン押下

    state LaunchGhost {
        [*] --> Launching
        Launching --> LaunchSuccess : SSP 起動成功
        Launching --> LaunchError : SSP 起動失敗
        LaunchSuccess --> [*]
        LaunchError --> [*]
    }

    LaunchGhost --> Ready
```

### 9.2 ゴーストスキャンの詳細状態遷移

```mermaid
stateDiagram-v2
    [*] --> BuildRequestKey : refresh() 呼び出し

    BuildRequestKey --> CheckInFlight : requestKey 生成
    CheckInFlight --> [*] : 同一リクエスト処理中（スキップ）
    CheckInFlight --> CheckForceFullScan : 新規リクエスト

    CheckForceFullScan --> LoadPreloadedCache : 通常スキャン
    CheckForceFullScan --> ExecuteFullScan : 強制フルスキャン

    LoadPreloadedCache --> ShowCached : preloaded キャッシュあり
    LoadPreloadedCache --> ReadStoreCache : preloaded なし

    ReadStoreCache --> ShowCached : ストアキャッシュあり
    ReadStoreCache --> ExecuteFullScan : キャッシュなし

    ShowCached --> ValidateFingerprint : UI にキャッシュ表示済み
    ValidateFingerprint --> Done : fingerprint 一致
    ValidateFingerprint --> ExecuteFullScan : fingerprint 不一致 / エラー

    ExecuteFullScan --> UpdateUI : スキャン成功
    ExecuteFullScan --> HandleError : スキャン失敗

    UpdateUI --> WriteCacheAsync : UI 更新
    WriteCacheAsync --> Done : キャッシュ書き込み（非同期）

    HandleError --> Done : エラー表示

    Done --> [*]
```

### 9.3 GhostList コンポーネントの表示状態

```mermaid
stateDiagram-v2
    [*] --> Loading : loading=true

    Loading --> ErrorState : エラー発生
    Loading --> EmptyState : ゴースト 0 件
    Loading --> DisplayList : ゴースト 1 件以上

    ErrorState --> Loading : 再読込
    EmptyState --> Loading : 再読込 / 設定変更
    DisplayList --> Loading : 再読込 / 設定変更

    state DisplayList {
        [*] --> CheckThreshold
        CheckThreshold --> NormalRendering : 80 件未満
        CheckThreshold --> VirtualizedRendering : 80 件以上
    }
```

---

## 10. UI 構成

### 10.1 画面構成

```
┌──────────────────────────────────────┐
│ AppHeader                            │
│  「Ghost Launcher」  [再読込] [設定]  │
├──────────────────────────────────────┤
│ GhostContent                         │
│  ┌──────────────────────┐            │
│  │ SearchBox             │            │
│  │ [🔍 ゴースト名で検索]  │            │
│  └──────────────────────┘            │
│  「N 体のゴースト」                    │
│  ┌──────────────────────────────────┐│
│  │ GhostCard                        ││
│  │  ゴースト名        [起動]         ││
│  │  directory_name [ソースバッジ]     ││
│  ├──────────────────────────────────┤│
│  │ GhostCard                        ││
│  │  ...                             ││
│  └──────────────────────────────────┘│
└──────────────────────────────────────┘

        設定ダイアログ（モーダル）
┌──────────────────────────────────────┐
│ 設定                                  │
│  SSP フォルダ: [         ] [選択]      │
│                                      │
│  追加ゴーストフォルダ           [追加]  │
│  ┌──────────────────────────────────┐│
│  │ C:\Ghosts\Extra        [削除]    ││
│  │ D:\MyGhosts            [削除]    ││
│  └──────────────────────────────────┘│
│                             [閉じる]  │
└──────────────────────────────────────┘
```

### 10.2 レスポンシブ対応

- 最大幅: 960px（中央寄せ）
- ウィンドウ最小幅: 520px、最小高: 560px
- 600px 以下でグリッドを 1 カラムに崩す

### 10.3 テーマ

- OS の `prefers-color-scheme` に追従
- Fluent UI の `webLightTheme` / `webDarkTheme` を切り替え

---

## 11. CI/CD

### 11.1 CI ビルド（`ci-build.yml`）

- トリガー: `main` への push・PR
- 実行環境: `windows-latest`
- ステップ: `npm run build` → `check:ui-guidelines` → `test:ui-guidelines-check` → `cargo check`

### 11.2 リリース（`release.yml`）

- トリガー: `v*` タグ push
- 実行環境: `windows-latest`
- ステップ: `npx tauri build --no-bundle` → ポータブル ZIP 作成 → GitHub Release 作成（自動リリースノート）

---

## 12. 設定ファイル仕様

### 12.1 永続化方法

`@tauri-apps/plugin-store` の `LazyStore` を使用。ファイルは Tauri のアプリデータディレクトリ内の `settings.json` に保存される。

### 12.2 設定保存のタイミング

- SSP パス変更: 即時 `set` + `save`
- 追加フォルダ追加/削除: 楽観的 UI 更新 → 永続化失敗時はロールバック

---

## 13. エラーハンドリング方針

| 場面 | 挙動 |
|------|------|
| SSP の `ghost/` フォルダ不在 | Rust 側でエラー返却 → フロントエンドでエラー表示 |
| 追加フォルダ不在・読取不能 | 無視して続行（フィンガープリントにはトークンとして記録） |
| `descript.txt` 不在 | そのゴーストをスキップ |
| `descript.txt` に `name` 未定義 | ディレクトリ名をフォールバック表示名とする |
| `ssp.exe` 不在 | 起動時エラー表示（`role="alert"`） |
| スキャンエラー（キャッシュ表示済み） | キャッシュ表示を維持し、エラーを抑制 |
| スキャンエラー（キャッシュなし） | エラーメッセージ表示 + ゴーストリストクリア |
| 設定保存失敗 | コンソールエラー + UI ロールバック |
| キャッシュ書き込み失敗 | コンソールエラーのみ（UI 影響なし） |

---

## 14. 確認事項と回答

以下はコードリーディングの過程で生じた疑問・不明点と、オーナーへの確認結果です。

### C-01: ウィンドウの初期表示タイミング

- **質問**: `tauri.conf.json` で `"visible": false` が設定されているが、ウィンドウの表示はどのように行われるか？
- **回答**: **`tauri-plugin-window-state` が復元完了後に自動表示する。** `visible: false` は起動時のチラつき（デフォルト位置に一瞬表示されてから保存位置にジャンプする現象）を防ぐための意図的な設定。
- **状態**: 確認済み・現状維持

### C-02: クロスプラットフォーム対応の意図

- **質問**: `launch_ghost` は `ssp.exe` をハードコードしており Windows 専用だが、`bundle.targets` は `"all"` である。
- **回答**: **Windows 限定。** SSP 自体が Windows 専用であるため、本アプリも Windows 限定とする。
- **状態**: 確認済み・現状維持

### C-03: CSP（Content Security Policy）の設定

- **質問**: `tauri.conf.json` で `"csp": null` に設定されているが、プロダクションでもこのままか？
- **回答**: **意識していなかった。** 外部リソースを読み込まずローカル完結のアプリであるが、セキュリティ強化のため適切な CSP 設定を今後検討する。
- **状態**: 要検討（将来改善）

### C-04: フィンガープリントのハッシュ安定性

- **質問**: `DefaultHasher`（SipHash）は Rust バージョン間で安定性が保証されないが、許容するか？
- **回答**: **安定ハッシュに切り替えたい。** SHA-256 等のバージョン間で安定したハッシュアルゴリズムへの移行を行う。
- **状態**: 要対応（改善タスク）

### C-05: キャッシュエントリの肥大化

- **質問**: `GhostCacheStoreV1` に古いエントリを削除する仕組みがないが、上限や有効期限は必要か？
- **回答**: **将来的に導入したい。** 有効期限やエントリ数上限の仕組みを導入する。
- **状態**: 要対応（将来改善）

### C-06: SSP パス設定時のバリデーション

- **質問**: SSP パス保存時に `ssp.exe` や `ghost/` の存在確認を行っていないが、バリデーションを追加するか？
- **回答**: **保存時バリデーションを追加したい。** フォルダ選択時に `ssp.exe` の存在を確認し、不正なパスの場合は警告を表示する。
- **状態**: 要対応（改善タスク）

### C-07: フロントエンドのテスト基盤

- **質問**: React コンポーネントやカスタムフックのユニットテスト基盤がないが、導入予定はあるか？
- **回答**: **導入予定あり。** vitest 等のフロントエンドテスト基盤を導入する。
- **状態**: 要対応（将来改善）

### C-08: Cargo.toml の `publish = true`

- **質問**: デスクトップアプリの Rust クレートで `publish = true` が設定されているが、crates.io 公開を意図しているか？
- **回答**: **意図せず、`publish = false` に修正すべき。**
- **状態**: 要修正

### C-09: 複数の SSP インスタンス起動制御

- **質問**: `launch_ghost` は `Command::spawn()` でプロセス終了を待たないが、重複起動防止は SSP 側に任せているか？
- **回答**: **SSP 側に任せている。** SSP 自体が重複起動を制御するため、ランチャー側での制御は不要。
- **状態**: 確認済み・現状維持

### C-10: `scan_ghosts_with_meta` と `build_fingerprint` のロジック重複

- **質問**: `scan.rs` と `fingerprint.rs` にフィンガープリントトークン生成の実質同一ロジックがあるが、意図的な重複か？
- **回答**: **統合したい。** トークン生成ロジックを共通化し、DRY 原則に沿ったリファクタリングを行う。
- **状態**: 要対応（改善タスク）

---

## 15. 改善タスク一覧

確認事項から導出された改善タスクの一覧:

| 優先度 | タスク                            | 関連 | 概要                                                              |
|--------|-----------------------------------|------|-------------------------------------------------------------------|
| 高     | `publish = false` に修正          | C-08 | `Cargo.toml` の `publish` を `false` に変更                       |
| 高     | 安定ハッシュへの移行              | C-04 | `DefaultHasher` → SHA-256 等の安定ハッシュに切り替え              |
| 高     | フィンガープリントロジック統合    | C-10 | `scan.rs` と `fingerprint.rs` のトークン生成ロジックを共通化      |
| 中     | SSP パス保存時バリデーション      | C-06 | フォルダ選択時に `ssp.exe` / `ghost/` の存在確認を追加            |
| 中     | CSP 設定の検討                    | C-03 | `tauri.conf.json` に適切な CSP を設定                             |
| 低     | キャッシュエントリの有効期限/上限 | C-05 | 古いキャッシュエントリの自動削除機能を追加                        |
| 低     | フロントエンドテスト基盤導入      | C-07 | vitest 等によるユニットテスト・インテグレーションテスト基盤を構築 |
