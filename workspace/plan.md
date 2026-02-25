# Ghost Launcher 改善タスク 修正計画

作成日: 2026-02-25（初版）
レビュー更新: 2026-02-25（コードレビュー反映）
前提資料: `workspace/research.md`

---

## 実施方針の確定

research.md の調査を踏まえ、以下の設計方針を確定した上で計画を策定する。

| 事項 | 決定 |
|------|------|
| T-2 と T-3 の実施単位 | 同一 PR で実施（`compute_fingerprint_hash` を共有するため分離不可） |
| ハッシュ出力長 | SHA-256 の 64 桁 hex（truncation なし）。SPEC §7.2 を同時更新する |
| キャッシュバージョン扱い | `version: 1` のまま。旧フィンガープリントは初回フルスキャンで自然に上書きされる |
| SSP パスバリデーション手段 | 新規 Rust コマンド `validate_ssp_path`（既存コマンド主導パターンに準拠） |
| SSP パスバリデーションスコープ | `ssp.exe` の存在確認のみ。`ghost/` 確認は `scan_ghosts_with_meta` が担当（YAGNI） |
| CSP の `unsafe-inline` | Fluent UI v9 / Griffel の制約上 `style-src` に `'unsafe-inline'` 必須 |
| キャッシュ上限値 | `MAX_CACHE_ENTRIES = 10`（定数として `ghostCacheRepository.ts` に埋め込み） |
| T-3 統合アプローチ | 共通ヘルパー `push_entry_token` 抽出。戻り値 `String`（descript_state）で scan.rs が Ghost 構築判定に再利用。`build_fingerprint` の軽量性は維持 |
| vitest globals | 使用しない（明示的 import を推奨）。`tsconfig.json` への `"types": ["vitest/globals"]` 追加が不要 |

---

## PR-1: `publish = false` に修正（T-1）

**優先度: 高 / 影響範囲: 最小**

### 変更対象ファイル
- `src-tauri/Cargo.toml`

### 変更内容

```toml
# Before
publish = true

# After
publish = false
```

### フロー・状態への影響
なし。メタデータ変更のみ。

### 検証
```bash
cd src-tauri && cargo check
```

---

## PR-2: 安定ハッシュ移行 + フィンガープリントロジック統合（T-2 + T-3）

**優先度: 高 / 影響範囲: バックエンド Rust（fingerprint.rs, scan.rs, Cargo.toml）+ SPEC.md**

### 背景・理由

T-2（SHA-256 移行）と T-3（ロジック統合）は `compute_fingerprint_hash` を共有しているため、
別 PR に分けると同関数を 2 度変更する羽目になる。同一 PR での実施が必須。

### 変更対象ファイル
1. `src-tauri/Cargo.toml`
2. `src-tauri/src/commands/ghost/fingerprint.rs`
3. `src-tauri/src/commands/ghost/scan.rs`
4. `SPEC.md`（§7.2 の記述更新）

---

### Step 1: Cargo.toml に sha2 クレートを追加

```toml
# [dependencies] に追加
sha2 = "0.10"
```

`sha2 = "0.10"` は `digest` トレイトを内包する。`hex` クレートは不要
（バイト配列を `{:02x}` でフォーマットすることで対応する）。

---

### Step 2: fingerprint.rs を改訂

#### 2-1: インポートの差し替え

```rust
// 削除（2行とも）
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

// 追加
use sha2::{Digest, Sha256};
```

`use std::hash::{Hash, Hasher}` は `Hash` と `Hasher` を同時に含む1行であり、
**1行丸ごと削除する**こと（`Hasher` トレイトの削除漏れに注意）。

#### 2-2: `compute_fingerprint_hash` を SHA-256 に置き換え

```rust
// Before (fingerprint.rs:35-42)
pub(crate) fn compute_fingerprint_hash(tokens: &mut Vec<String>) -> String {
    tokens.sort();
    let mut hasher = DefaultHasher::new();
    for token in tokens.iter() {
        token.hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

// After
pub(crate) fn compute_fingerprint_hash(tokens: &mut Vec<String>) -> String {
    tokens.sort();
    let mut hasher = Sha256::new();
    for token in tokens.iter() {
        hasher.update(token.as_bytes());
        hasher.update(b"\n"); // トークン間の区切り（境界混同防止）
    }
    hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}
```

#### 2-3: 共通ヘルパー `push_entry_token` を追加（T-3 の核心）

`push_parent_fingerprint_tokens` の内部ループと
`scan_ghost_dir_with_fingerprint` の内部ループに存在するトークンフォーマット文字列の重複を解消する。

**シグネチャは最初から戻り値 `String` で定義する**（scan.rs が Ghost 構築判定に使用するため）。

```rust
/// ゴーストエントリ1件分のフィンガープリントトークンを生成して push する。
/// scan.rs と fingerprint.rs の共通ロジック。
/// 戻り値: descript_state（"missing" / "present" / "unreadable"）
/// scan.rs が Ghost 構築判定に使用する。fingerprint.rs では戻り値を無視してよい。
pub(crate) fn push_entry_token(
    tokens: &mut Vec<String>,
    parent_label: &str,
    normalized_parent: &str,
    directory_name: &str,
    entry_meta: &fs::Metadata,
    descript_path: &Path,
) -> String {
    let dir_modified = metadata_modified_string(entry_meta);
    let (descript_state, descript_modified) = descript_metadata_for_token(descript_path);
    tokens.push(format!(
        "entry|{}|{}|{}|{}|{}|{}",
        parent_label, normalized_parent, directory_name,
        dir_modified, descript_state, descript_modified
    ));
    descript_state
}
```

#### 2-4: `push_parent_fingerprint_tokens` の内部ループを `push_entry_token` に委譲

削除する変数: `dir_modified`、`descript_state`、`descript_modified`（すべて `push_entry_token` 内部に移動）

```rust
// push_parent_fingerprint_tokens の for ループ（fingerprint.rs line 107-141）を以下に置き換え:
for entry in entries {
    let entry = match entry {
        Ok(value) => value,
        Err(_) => continue,
    };
    // entry.metadata() は Windows では FindNextFile のキャッシュを利用（modified time 取得用）
    let entry_meta = match entry.metadata() {
        Ok(m) => m,
        Err(_) => continue,
    };
    let path = entry.path();
    if !path.is_dir() {
        continue;
    }
    let directory_name = match path.file_name().and_then(|name| name.to_str()) {
        Some(name) => name.to_string(),
        None => continue,
    };
    let descript_path = path.join("ghost").join("master").join("descript.txt");
    // 戻り値（descript_state）はフィンガープリント専用パスでは不要なので無視する
    push_entry_token(tokens, parent_label, &normalized_parent, &directory_name, &entry_meta, &descript_path);
}
```

---

### Step 3: scan.rs を改訂

#### 3-1: インポートを更新（`descript_metadata_for_token` を削除）

```rust
// Before (scan.rs:5-7)
use super::fingerprint::{
    compute_fingerprint_hash, descript_metadata_for_token, metadata_modified_string,
};

// After
use super::fingerprint::{
    compute_fingerprint_hash, metadata_modified_string, push_entry_token,
};
```

**`descript_metadata_for_token` は `push_entry_token` 内部で呼ばれるため、
scan.rs から直接インポートすると `unused import` 警告が発生する。必ず削除すること。**

`metadata_modified_string` は `scan_ghost_dir_with_fingerprint` の `parent_modified` 計算で
引き続き直接使用するため残す。

#### 3-2: `scan_ghost_dir_with_fingerprint` のループを `push_entry_token` に委譲

削除する変数: `dir_modified`、`descript_modified`（`push_entry_token` 内部に移動）
変更する変数: `(descript_state, descript_modified) = descript_metadata_for_token(...)` →
`descript_state = push_entry_token(...)`（代入式として直接受け取る）

```rust
// scan_ghost_dir_with_fingerprint の for ループ（scan.rs line 69-122）を以下に置き換え:
for entry in entries {
    let entry = match entry {
        Ok(e) => e,
        Err(_) => continue,
    };
    // entry.metadata() は Windows では FindNextFile のキャッシュを利用（modified time 取得用）
    let entry_meta = match entry.metadata() {
        Ok(m) => m,
        Err(_) => continue,
    };
    let path = entry.path();
    if !path.is_dir() {
        continue;
    }
    let directory_name = match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => name.to_string(),
        None => continue,
    };
    let descript_path = path.join("ghost").join("master").join("descript.txt");

    // トークン生成と descript_state 取得を共通ヘルパーに委譲
    let descript_state = push_entry_token(
        tokens, parent_label, normalized_parent, &directory_name, &entry_meta, &descript_path,
    );

    // descript.txt が存在する場合のみパースして Ghost を構築
    if descript_state != "missing" {
        if let Ok(fields) = descript::parse_descript(&descript_path) {
            let name = fields
                .get("name")
                .cloned()
                .unwrap_or_else(|| directory_name.clone());
            ghosts.push(Ghost {
                name,
                directory_name,
                path: path.to_string_lossy().into_owned(),
                source: source.to_string(),
            });
        }
    }
}
```

---

### SPEC.md 更新箇所

```markdown
# Before (§7.2)
3. 16桁16進数文字列として出力

# After
3. 64桁16進数文字列（SHA-256）として出力
```

---

### フロー・状態遷移への影響

#### 初回起動時（既存ユーザー）の状態遷移

```
CheckCache
  └─ ShowCachedGhosts（旧キャッシュ表示）
       └─ ValidateFingerprint
            ├─ get_ghosts_fingerprint() → 64桁 SHA-256 ハッシュ返却
            ├─ cachedEntry.fingerprint は旧 16桁 DefaultHasher ハッシュ
            └─ 不一致 → FullScan（一回のみ）
                   └─ 新しい 64桁フィンガープリントをキャッシュに書き込み
                          └─ 以降の起動では ValidateFingerprint → 一致 → Ready（即時表示）
```

**ユーザー体験**: 更新後の初回起動時のみフルスキャンが走る。旧キャッシュが先に表示されるため
ゴースト一覧が空白になることはないが、フルスキャン完了後に一覧が更新される。

#### 通常動作（新規ユーザー・更新後 2 回目以降）

変化なし。`validateCache` の `===` 比較はハッシュ長に依存しない文字列比較のため。

---

### 検証

```bash
cd src-tauri && cargo test
# 以下が全て通ることを確認:
# - unique_sorted_additional_folders_dedupes_by_normalized_path
# - build_fingerprint_is_order_independent_for_additional_folders
# - scan_ghosts_internal_collects_sources_and_sorts_by_name
# - scan_ghosts_internal_falls_back_to_directory_name_without_name_field
# - scan_ghosts_internal_returns_error_when_ssp_ghost_dir_is_missing
# - integrated_fingerprint_matches_standalone_build_fingerprint  ← 最重要
```

`integrated_fingerprint_matches_standalone_build_fingerprint` が通れば、
`build_fingerprint` と `scan_ghosts_with_fingerprint_internal` が同一ハッシュを返すことが保証される。

---

## PR-3: SSP パス保存時バリデーション（T-4）

**優先度: 中 / 影響範囲: Rust バックエンド（ssp.rs, lib.rs）+ フロントエンド（SettingsPanel.tsx）**

### 変更対象ファイル
1. `src-tauri/src/commands/ssp.rs`
2. `src-tauri/src/lib.rs`
3. `src/components/SettingsPanel.tsx`

---

### Step 1: ssp.rs に `validate_ssp_path` コマンドを追加

既存の `launch_ghost` コマンドと同ファイルに追加する（SSP 関連コマンドとして一貫）。

```rust
// ssp.rs に追加
/// SSP フォルダのパスを検証する（ssp.exe の存在確認）
#[tauri::command]
pub fn validate_ssp_path(ssp_path: String) -> Result<(), String> {
    let ssp_exe = Path::new(&ssp_path).join("ssp.exe");
    if !ssp_exe.exists() {
        return Err(format!("ssp.exe が見つかりません: {}", ssp_exe.display()));
    }
    Ok(())
}
```

---

### Step 2: lib.rs のハンドラ登録

```rust
// Before
.invoke_handler(tauri::generate_handler![
    commands::ghost::scan_ghosts_with_meta,
    commands::ghost::get_ghosts_fingerprint,
    commands::ssp::launch_ghost,
])

// After
.invoke_handler(tauri::generate_handler![
    commands::ghost::scan_ghosts_with_meta,
    commands::ghost::get_ghosts_fingerprint,
    commands::ssp::launch_ghost,
    commands::ssp::validate_ssp_path,
])
```

---

### Step 3: SettingsPanel.tsx を改訂

#### 追加するインポート

SettingsPanel.tsx は現在 **React を一切インポートしていない**（JSX transform により jsx は自動解決されるが、
フック類は明示的インポートが必須）。

```tsx
// 追加（ファイル先頭）
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
```

#### 追加するローカル状態

```tsx
// コンポーネント関数内に追加
const [validationError, setValidationError] = useState<string | null>(null);
const [validating, setValidating] = useState(false);
```

`validating` は選択ボタンの重複クリックを防ぐために使用する
（`validate_ssp_path` は高速だが非同期であるため）。

#### 変更前のフロー

```
handleSelectFolder()
  └─ open({ directory: true })
       └─ selected → onPathChange(selected)
```

#### 変更後のフロー

```
handleSelectFolder()
  └─ open({ directory: true })
       └─ selected
            └─ invoke("validate_ssp_path", { sspPath: selected })
                 ├─ 成功 → onPathChange(selected) + setValidationError(null)
                 └─ 失敗 → setValidationError(エラーメッセージ)
                           ※ onPathChange は呼ばれない
```

#### `handleSelectFolder` の変更

```tsx
// Before
const handleSelectFolder = async () => {
    const selected = await open({
        directory: true,
        multiple: false,
        title: "SSPフォルダを選択",
    });
    if (selected) {
        onPathChange(selected);
    }
};

// After
const handleSelectFolder = async () => {
    const selected = await open({
        directory: true,
        multiple: false,
        title: "SSPフォルダを選択",
    });
    if (!selected) return;

    setValidating(true);
    try {
        await invoke("validate_ssp_path", { sspPath: selected });
        onPathChange(selected);
        setValidationError(null);
    } catch (e) {
        setValidationError(e instanceof Error ? e.message : String(e));
    } finally {
        setValidating(false);
    }
};
```

#### JSX の変更（`validationState` prop）

Fluent UI v9 `Field` の `validationState` の型は `"error" | "warning" | "success" | undefined`。
**`"none"` は存在しない**。未設定時は `undefined` を渡すこと。

```tsx
// Before
<div className={styles.row}>
    <Field label="SSPフォルダ">
        <Input readOnly value={sspPath ?? "未設定"} />
    </Field>
    <Button icon={<FolderOpenRegular />} appearance="secondary" onClick={handleSelectFolder}>
        選択
    </Button>
</div>

// After
<div className={styles.row}>
    <Field
        label="SSPフォルダ"
        validationState={validationError ? "error" : undefined}
        validationMessage={validationError ?? undefined}
    >
        <Input readOnly value={sspPath ?? "未設定"} />
    </Field>
    <Button
        icon={<FolderOpenRegular />}
        appearance="secondary"
        onClick={handleSelectFolder}
        disabled={validating}
    >
        選択
    </Button>
</div>
```

#### `validationError` の残存問題

`SettingsPanel` は `App.tsx` の `Dialog` 内で**常にマウントされたまま**（`open` prop で表示/非表示を制御）。
Dialog を閉じても unmount されないため、前回のエラーが次回ダイアログ開放時に残存する。

**対処方針**: ダイアログの `onOpenChange` で `open=true` になるタイミングで `validationError` をリセットしたいが、
`validationError` は SettingsPanel の内部 state であり、外部からリセットできない。

簡単な解決策: SettingsPanel に `onOpen` callback を追加せず、
**エラーはユーザーが次の選択操作で自然に上書きされる**挙動を許容する。
（SSP パスが設定済みの場合は前回エラーが表示されても実害は薄い）

もし厳密にリセットしたい場合は、SettingsPanel に `key={settingsOpen ? "open" : "closed"}` を渡して
Dialog 開放のたびに再マウントする方法があるが、YAGNI として現時点では省略する。

---

### フロー・状態遷移への影響

#### シナリオ A: SSP パス未設定 → 無効フォルダを選択

```
[起動]
  └─ sspPath = null → setSettingsOpen(true)（App.tsx の useEffect）
       └─ SettingsPanel 表示
            └─ [ユーザーが ssp.exe のないフォルダを選択]
                 └─ validate_ssp_path → Err
                      └─ validationError 表示 + sspPath は null のまま
                           └─ ダイアログは開いたまま（App.tsx useEffect が維持）
```

#### シナリオ B: SSP パス設定済み → 別の無効フォルダを選択

```
[通常状態: sspPath = "C:\SSP"]
  └─ [ユーザーが設定を開いて別フォルダを選択（ssp.exe なし）]
       └─ validate_ssp_path → Err
            └─ validationError 表示
            └─ onPathChange は呼ばれない
            └─ sspPath は "C:\SSP" のまま（現在の設定を維持）
```

#### シナリオ C: 有効フォルダを選択（正常ケース）

```
[open() → selected = "C:\SSP_New"]
  └─ validate_ssp_path → Ok
       └─ onPathChange("C:\SSP_New")
            └─ useSettings.saveSspPath → settingsStore.set + save
                 └─ setSspPath("C:\SSP_New")
                      └─ useGhosts の refresh() が sspPath 変更で再実行
                           └─ 新パスでスキャン開始
```

---

### 検証

```bash
cd src-tauri && cargo check
npm run build
```

---

## PR-4: CSP 設定（T-5）

**優先度: 中 / 影響範囲: tauri.conf.json のみ**

### 変更対象ファイル
- `src-tauri/tauri.conf.json`

### 変更内容

Fluent UI v9（Griffel）との互換性要件:
- `style-src 'unsafe-inline'` は必須（Griffel が実行時に `<style>` を注入する）
- Tauri 2 の IPC 通信には `ipc:` スキームを許可する必要がある
- Tauri 2 は起動時に IPC ブリッジの JavaScript を WebView に inject することがある
  → `script-src 'self'` のみでは動作しない可能性があり、`'unsafe-inline'` が必要になりうる
- 外部ネットワークアクセスは不要（ローカル完結アプリ）

```json
// Before
"security": {
  "csp": null
}

// After（起点案）
"security": {
  "csp": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src ipc: http://ipc.localhost; font-src 'self' data:; img-src 'self' data: blob:"
}
```

各ディレクティブの根拠:
| ディレクティブ | 値 | 理由 |
|---|---|---|
| `default-src` | `'self'` | 基本制限 |
| `script-src` | `'self' 'unsafe-inline'` | Tauri 2 が inject する IPC ブリッジスクリプトに `'unsafe-inline'` が必要な場合がある |
| `style-src` | `'self' 'unsafe-inline'` | Griffel（Fluent UI）の動的 style 注入 |
| `connect-src` | `ipc: http://ipc.localhost` | Tauri 2 の IPC 通信プロトコル |
| `font-src` | `'self' data:` | Fluent UI のアイコンフォント |
| `img-src` | `'self' data: blob:` | アセット・インライン画像 |

### 注意: 実機確認が必須

以下の手順で CSP エラーが出ないことを確認すること:

1. `npm run tauri dev` でアプリを起動
2. WebView の開発者ツール（F12）→ Console タブを開く
3. CSP 関連のエラーがないことを確認
4. 全コンポーネントが正常にスタイル適用されていることを確認
5. 設定パネルを開くなど全操作を実行して動作確認

`script-src 'unsafe-inline'` が不要であれば削除してよい（よりセキュアになる）が、
削除後は再度 Tauri dev での動作確認が必要。

**開発時と本番ビルドで異なる可能性**:
Tauri 2 開発モードでは CSP が WebView に適用されるかどうかがバージョンによって異なる。
`tauri dev` と `tauri build` の両方で動作確認すること。

---

### フロー・状態への影響

UI レンダリングの動作に変化がなければ影響なし。
Griffel の `makeStyles` が生成するスタイルは `'unsafe-inline'` で許可されるため、
全コンポーネントの外観は維持される。

---

## PR-5: キャッシュエントリ上限の実装（T-6）

**優先度: 低 / 影響範囲: ghostCacheRepository.ts のみ**

**推奨: PR-2（SHA-256 移行）の後に実施**
（PR-2 により全既存エントリが無効化→フルスキャン→新エントリ書き込みの流れが発生するため、
その後にエントリ管理を導入するのが自然）

### 変更対象ファイル
- `src/lib/ghostCacheRepository.ts`

### 変更内容

#### 追加: 定数と pruning 関数

```typescript
const MAX_CACHE_ENTRIES = 10;

function pruneOldEntries(store: GhostCacheStoreV1): void {
    const entries = Object.entries(store.entries);
    if (entries.length <= MAX_CACHE_ENTRIES) return;

    // cached_at 降順（新しい順）でソートし、上限を超えた古いエントリを削除
    entries.sort(([, a], [, b]) =>
        new Date(b.cached_at).getTime() - new Date(a.cached_at).getTime()
    );
    store.entries = Object.fromEntries(entries.slice(0, MAX_CACHE_ENTRIES));
}
```

#### 変更: `writeGhostCacheEntry` に pruning を追加

```typescript
export async function writeGhostCacheEntry(
    requestKey: string,
    entry: GhostCacheEntry,
): Promise<void> {
    const runWrite = async () => {
        const cacheStore = await readGhostCacheStore();
        cacheStore.entries[requestKey] = entry;
        pruneOldEntries(cacheStore);  // ← 追加
        await settingsStore.set(GHOST_CACHE_KEY, cacheStore);
        await settingsStore.save();
    };

    cacheWriteQueue = cacheWriteQueue.then(runWrite, runWrite);
    await cacheWriteQueue;
}
```

---

### フロー・状態遷移への影響

#### キャッシュ書き込みフロー（変更後）

```
useGhosts.ts:
  └─ writeGhostCacheEntry(requestKey, entry)  [fire-and-forget]
       └─ cacheWriteQueue にエンキュー（直列実行保証）
            └─ readGhostCacheStore()
                 └─ cacheStore.entries[requestKey] = entry
                      └─ pruneOldEntries(cacheStore)
                           └─ エントリ数 <= 10: 何もしない
                           └─ エントリ数 > 10: 古い順に削除
                                └─ settingsStore.set + save
```

#### UI への影響

`writeGhostCacheEntry` は fire-and-forget で呼ばれており、
`useGhosts.ts` の `catch` でコンソールエラーのみ記録する。
pruning は `writeGhostCacheEntry` の内部処理であるため、UI 状態に変化なし。

---

### 検証

```bash
npm run build
```

---

## PR-6: フロントエンドテスト基盤導入（T-7）

**優先度: 低 / 影響範囲: 広範（設定ファイル・モック・テストファイル・CI）**

### 変更対象ファイル
1. `package.json`
2. `vitest.config.ts`（新規）
3. `tsconfig.node.json`（vitest.config.ts を追加）
4. `src/test/setup.ts`（新規）
5. `src/test/mocks/@tauri-apps/api/core.ts`（新規）
6. `src/test/mocks/@tauri-apps/plugin-store.ts`（新規）
7. `src/test/mocks/@tauri-apps/plugin-dialog.ts`（新規）
8. テストファイル群（新規）
9. `.github/workflows/ci-build.yml`

---

### Step 1: 依存パッケージ追加

```bash
npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom
```

**React 19 互換について**: `@testing-library/react` は v16+ が React 18/19 に対応。
`npm install -D @testing-library/react` で最新版が入るが、
`peer dependency` の警告が出る場合は `--legacy-peer-deps` フラグを使うこと。

---

### Step 2: vitest.config.ts 作成

```typescript
// vitest.config.ts（新規）
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            // Tauri API のモック差し替え（テスト環境のみ有効）
            "@tauri-apps/api/core": resolve(__dirname, "src/test/mocks/@tauri-apps/api/core.ts"),
            "@tauri-apps/plugin-store": resolve(__dirname, "src/test/mocks/@tauri-apps/plugin-store.ts"),
            "@tauri-apps/plugin-dialog": resolve(__dirname, "src/test/mocks/@tauri-apps/plugin-dialog.ts"),
        },
    },
    test: {
        environment: "jsdom",
        setupFiles: ["src/test/setup.ts"],
        // globals は使用しない（各テストファイルで明示的に import する）
    },
});
```

**alias のパス形式について**: alias には必ず `resolve(__dirname, "...")` で得た絶対パスを使うこと。
`"/src/..."` のようなスラッシュ始まりのパスは OS ルートからの絶対パスとして解釈され、
プロジェクトの `src/` ディレクトリを指さない。

---

### Step 3: tsconfig.node.json の更新

現在 `tsconfig.node.json` は `vite.config.ts` のみ含む。`vitest.config.ts` を追加する。

```json
// tsconfig.node.json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts", "vitest.config.ts"]
}
```

---

### Step 4: セットアップファイルと Tauri API モック

#### src/test/setup.ts

```typescript
import "@testing-library/jest-dom";
```

#### src/test/mocks/@tauri-apps/api/core.ts

```typescript
// invoke のモック: テストごとに vi.mocked(invoke).mockResolvedValue(...) で制御
import { vi } from "vitest";
export const invoke = vi.fn();
```

#### src/test/mocks/@tauri-apps/plugin-store.ts

モジュールレベルシングルトン（`settingsStore.ts` で `new LazyStore("settings.json")` が1度だけ実行される）
のため、テスト間で state が共有される。テストで `readGhostCacheEntry` 等を使う際は
`beforeEach` でモックをリセットすること（詳細は Step 6 参照）。

`get` メソッドは型引数 `<T>` に対応させる（TypeScript strict モードで型エラーにならないよう）。

```typescript
import { vi } from "vitest";

export class LazyStore {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private store: Record<string, any> = {};

    get = vi.fn(<T>(key: string): Promise<T | null> =>
        Promise.resolve(key in this.store ? (this.store[key] as T) : null)
    );

    set = vi.fn(async (key: string, value: unknown): Promise<void> => {
        this.store[key] = value;
    });

    save = vi.fn(async (): Promise<void> => {});
}
```

#### src/test/mocks/@tauri-apps/plugin-dialog.ts

```typescript
import { vi } from "vitest";
export const open = vi.fn();
export const confirm = vi.fn();
```

---

### Step 5: package.json にテストスクリプト追加

```json
"scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "check:ui-guidelines": "node scripts/check-ui-guidelines.mjs",
    "test:ui-guidelines-check": "node --test scripts/check-ui-guidelines.test.mjs",
    "preview": "vite preview",
    "tauri": "tauri"
}
```

---

### Step 6: 初期テスト実装（CLAUDE.md の作業フロー: テスト先行）

**重要**: 各テストファイルは `vitest` から明示的 import を行うこと（`globals: true` 不使用）。
`tsconfig.json` の `"noUnusedLocals": true` と `"noUnusedParameters": true` が
`src/` 以下の全ファイルに適用されるため、テストコード内でも未使用変数はエラーになる。

#### ghostScanUtils のテスト（純粋関数・モック不要）

```typescript
// src/lib/ghostScanUtils.test.ts
import { describe, it, expect } from "vitest";
import { normalizePathKey, buildAdditionalFolders, buildRequestKey } from "./ghostScanUtils";

describe("normalizePathKey", () => {
    it("バックスラッシュをスラッシュに変換する", () => {
        expect(normalizePathKey("C:\\SSP")).toBe("c:/ssp");
    });
    it("末尾スラッシュを除去する（ドライブルート除く）", () => {
        expect(normalizePathKey("C:/SSP/")).toBe("c:/ssp");
    });
    it("ドライブルートの末尾スラッシュを維持する", () => {
        expect(normalizePathKey("C:/")).toBe("c:/");
    });
});

describe("buildAdditionalFolders", () => {
    it("正規化パスで重複排除してソートする", () => {
        const result = buildAdditionalFolders([
            "C:\\Ghosts\\Extra",
            "c:/ghosts/extra",
            "C:/Ghosts/Another",
        ]);
        expect(result).toHaveLength(2);
    });
});

describe("buildRequestKey", () => {
    it("SSP パスと追加フォルダから requestKey を生成する", () => {
        const key = buildRequestKey("C:\\SSP", ["C:\\Ghosts"]);
        expect(key).toBe("c:/ssp::c:/ghosts");
    });
    it("追加フォルダなしの場合も正しく生成する", () => {
        const key = buildRequestKey("C:/SSP", []);
        expect(key).toBe("c:/ssp::");
    });
});
```

#### isGhostCacheStoreV1 のテスト（モック不要・settingsStore 非依存）

```typescript
// src/lib/ghostCacheRepository.test.ts
import { describe, it, expect } from "vitest";
import { isGhostCacheStoreV1 } from "./ghostCacheRepository";

describe("isGhostCacheStoreV1", () => {
    it("version=1 かつ entries が object の場合 true を返す", () => {
        expect(isGhostCacheStoreV1({ version: 1, entries: {} })).toBe(true);
    });
    it("version が異なる場合 false を返す", () => {
        expect(isGhostCacheStoreV1({ version: 2, entries: {} })).toBe(false);
    });
    it("null の場合 false を返す", () => {
        expect(isGhostCacheStoreV1(null)).toBe(false);
    });
    it("entries が存在しない場合 false を返す", () => {
        expect(isGhostCacheStoreV1({ version: 1 })).toBe(false);
    });
});
```

**注意**: `readGhostCacheEntry` や `writeGhostCacheEntry` のテストを書く場合は、
`settingsStore` シングルトンがモック間で状態を保持する問題がある。
以下のパターンで各テスト前にリセットすること:

```typescript
// readGhostCacheEntry テストを書く場合の例
import { beforeEach, describe, it, expect, vi } from "vitest";
import { settingsStore } from "./settingsStore";

beforeEach(() => {
    vi.clearAllMocks();
    // settingsStore のインメモリ状態もリセット
    // (モックの LazyStore インスタンスの store は vi.clearAllMocks で
    //  関数呼び出し履歴はリセットされるが store の内容は残る)
    // → 型アサーションで直接リセットする:
    (settingsStore as unknown as { store: Record<string, unknown> }).store = {};
});
```

#### useSearch のテスト（Tauri 依存なし）

```typescript
// src/hooks/useSearch.test.ts
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSearch } from "./useSearch";
import type { GhostView } from "../types";

const mockGhosts: GhostView[] = [
    {
        name: "Reimu", directory_name: "hakurei", path: "/hakurei", source: "ssp",
        name_lower: "reimu", directory_name_lower: "hakurei",
    },
    {
        name: "Marisa", directory_name: "kirisame", path: "/kirisame", source: "ssp",
        name_lower: "marisa", directory_name_lower: "kirisame",
    },
];

describe("useSearch", () => {
    it("空クエリでは全件返す", () => {
        const { result } = renderHook(() => useSearch(mockGhosts, ""));
        expect(result.current).toHaveLength(2);
    });
    it("name で部分一致フィルタリングする", () => {
        const { result } = renderHook(() => useSearch(mockGhosts, "reim"));
        expect(result.current).toHaveLength(1);
        expect(result.current[0].name).toBe("Reimu");
    });
    it("directory_name で部分一致フィルタリングする", () => {
        const { result } = renderHook(() => useSearch(mockGhosts, "kiris"));
        expect(result.current).toHaveLength(1);
        expect(result.current[0].directory_name).toBe("kirisame");
    });
    it("大文字小文字を区別しない", () => {
        const { result } = renderHook(() => useSearch(mockGhosts, "REIMU"));
        expect(result.current).toHaveLength(1);
    });
    it("スペースのみのクエリでは全件返す", () => {
        const { result } = renderHook(() => useSearch(mockGhosts, "  "));
        expect(result.current).toHaveLength(2);
    });
});
```

---

### Step 7: ci-build.yml へのテスト実行ステップ追加

```yaml
# ci-build.yml に追加（Build frontend の直後）
- name: Run frontend tests
  run: npm test
```

---

### フロー・状態遷移への影響

CI パイプライン変更:

```
# Before
npm run build
→ check:ui-guidelines
→ test:ui-guidelines-check
→ cargo check

# After
npm run build
→ npm test  ← 追加
→ check:ui-guidelines
→ test:ui-guidelines-check
→ cargo check
```

---

## 全体の実施順序と依存グラフ

```
PR-1 (T-1: publish=false)    ← 即実施可能、他タスク非依存
     │
     ▼
PR-2 (T-2+T-3: SHA-256 + ロジック統合)   ← T-2/T-3 を同時実施
     │
     ├──► PR-3 (T-4: SSP バリデーション)  ← PR-2 と独立して実施可能
     │
     ├──► PR-4 (T-5: CSP 設定)            ← PR-2 と独立して実施可能（実機確認必須）
     │
     └──► PR-5 (T-6: キャッシュ上限)      ← PR-2 後に実施推奨（キャッシュリセット後が自然）
               │
               ▼
          PR-6 (T-7: フロントエンドテスト基盤)  ← 最後（テスト対象コードが安定してから）
```

---

## コードレビューで発見した修正済み問題一覧

| 問題 | 重要度 | 対象 PR | 修正内容 |
|------|--------|---------|---------|
| `push_entry_token` シグネチャが Step 2-2 と 3-2 で矛盾（Step 3-2 のブロック構文は `()` 型を返しコンパイルエラー） | 致命的 | PR-2 | Step 2-3 から最初から戻り値 `String` の正しいシグネチャに統一 |
| scan.rs に `descript_metadata_for_token` の unused import が残る | 高 | PR-2 | Step 3-1 で削除を明示 |
| fingerprint.rs の削除インポートで `Hasher` が抜けていた | 高 | PR-2 | Step 2-1 で `use std::hash::{Hash, Hasher}` 1行全体の削除を明示 |
| `SettingsPanel.tsx` に `useState` の React インポートなし（「既に含まれている」は誤記） | 致命的 | PR-3 | Step 3 で `import { useState } from "react"` を追加 |
| `validationState="none"` は Fluent UI に存在しない（TypeScript strict エラー） | 致命的 | PR-3 | `undefined` に修正 |
| バリデーション中の重複クリック防止が未記載 | 中 | PR-3 | `validating` state と `disabled` を追加 |
| `validationError` がダイアログ再開後も残存する問題が未検討 | 中 | PR-3 | 挙動を許容する方針を明示 |
| `script-src 'self'` のみでは Tauri 2 inject スクリプトが動作しない可能性 | 高 | PR-4 | `'unsafe-inline'` を追加し実機確認を必須とした |
| alias パスが `/src/...`（OS ルート起点）で不正 | 致命的 | PR-6 | `fileURLToPath` + `resolve` を使うよう修正 |
| `tsconfig.node.json` への `vitest.config.ts` 追加が未記載 | 高 | PR-6 | Step 3 として追加 |
| `globals: true` とテストの明示 import が矛盾 | 中 | PR-6 | globals を使用しない方針に統一（明示 import） |
| `LazyStore` モックの `get` が型引数 `<T>` 非対応 | 高 | PR-6 | Step 4 のモック実装で型引数対応 |
| テスト間の settingsStore シングルトン状態リセット未記載 | 高 | PR-6 | Step 6 に beforeEach リセットパターンを追記 |

---

## 変更ファイル一覧（全 PR 合計）

| PR | ファイル | 変更種別 |
|----|---------|---------|
| PR-1 | `src-tauri/Cargo.toml` | 修正 |
| PR-2 | `src-tauri/Cargo.toml` | 修正（sha2 追加） |
| PR-2 | `src-tauri/src/commands/ghost/fingerprint.rs` | 修正 |
| PR-2 | `src-tauri/src/commands/ghost/scan.rs` | 修正 |
| PR-2 | `SPEC.md` | 修正（§7.2） |
| PR-3 | `src-tauri/src/commands/ssp.rs` | 修正 |
| PR-3 | `src-tauri/src/lib.rs` | 修正 |
| PR-3 | `src/components/SettingsPanel.tsx` | 修正 |
| PR-4 | `src-tauri/tauri.conf.json` | 修正 |
| PR-5 | `src/lib/ghostCacheRepository.ts` | 修正 |
| PR-6 | `package.json` | 修正 |
| PR-6 | `vitest.config.ts` | 新規 |
| PR-6 | `tsconfig.node.json` | 修正 |
| PR-6 | `src/test/setup.ts` | 新規 |
| PR-6 | `src/test/mocks/@tauri-apps/api/core.ts` | 新規 |
| PR-6 | `src/test/mocks/@tauri-apps/plugin-store.ts` | 新規 |
| PR-6 | `src/test/mocks/@tauri-apps/plugin-dialog.ts` | 新規 |
| PR-6 | `src/lib/ghostScanUtils.test.ts` | 新規 |
| PR-6 | `src/lib/ghostCacheRepository.test.ts` | 新規 |
| PR-6 | `src/hooks/useSearch.test.ts` | 新規 |
| PR-6 | `.github/workflows/ci-build.yml` | 修正 |
