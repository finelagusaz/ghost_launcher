# フィードバック対応 実装計画

作成日: 2026-02-25
前提資料: `workspace/review.md`

---

## 方針の確定

| 事項 | 決定 |
|------|------|
| 中-2（push_entry_token の SRP 混在） | 対応しない。コメントで意図が説明されており KISS/DRY のトレードオフとして現在は許容範囲 |
| 低-5（ssp.exe チェックの重複） | 対応しない。CLAUDE.md の「2回まで許容、3回目で抽出」を適用。現時点で2箇所のみ |
| 中-4（buildRequestKey のエッジケース） | 対応しない。Windows パスに `\|` は使えず実害がない。現状のテストで十分 |
| 中-1（script-src 'unsafe-inline'） | コード変更ではなく実機確認手順を Fix-F として記録する |
| 高-2 + 低-1 | 同じファイル群への変更のため Fix-E としてまとめて実施 |
| 高-1 + 低-2 | 同じファイルへの変更のため Fix-B としてまとめて実施 |
| 高-3 + 低-3 | 同じファイル群への変更のため Fix-C としてまとめて実施 |

---

## 実施順序

```
Fix-A  ci-build.yml: cargo check → cargo test          （影響最小、効果最大）
  │
  ▼
Fix-B  SettingsPanel.tsx: キャンセルエラークリア + 追加ボタン disabled
  │
  ▼
Fix-C  ghostCacheRepository: isGhostCacheStoreV1 強化 + テスト大幅追加
  │
  ▼
Fix-D  vitest.config.ts: include に .tsx 追加
  │
  ▼
Fix-E  fingerprint.rs / scan.rs: トークン重複解消 + ハッシュ関数シグネチャ修正
  │
  ▼
Fix-F  tauri.conf.json: 実機確認手順（コード変更なし）
```

---

## Fix-A: CI で `cargo test` を実行する（中-3）

### 変更対象
- `.github/workflows/ci-build.yml`（47行）

### 問題の詳細

現在の CI は `cargo check` のみで、`mod.rs` に定義された6つの充実した Rust テスト（`TempDirGuard` による実ファイルシステム統合テストを含む）がまったく実行されていない。`cargo test` は `cargo check` のスーパーセットであり、型チェック + テスト実行を兼ねるため、`cargo check` は `cargo test` で完全に置き換え可能。

### 影響分析

- CI 実行時間: `cargo test` は `cargo check` より長くかかる。sha2 等のクレートを含めた初回ビルドは20秒前後（ローカルで計測済み）。許容範囲内。
- 既存テスト（6件）: `TempDirGuard` は `std::env::temp_dir()` を使うため Windows の `windows-latest` 環境でも動作する。パス正規化テストも Windows パス形式（`C:\\`）を明示的にテストしている。
- 副作用: なし。`cargo test` はコンパイルアーティファクトを生成するが CI 環境のため問題なし。

### 変更内容

```yaml
# Before
- name: Check Rust crate
  run: cargo check --manifest-path src-tauri/Cargo.toml

# After
- name: Test Rust crate
  run: cargo test --manifest-path src-tauri/Cargo.toml
```

### 検証
CI が通ることを確認（ローカルでは `cargo test` が6件 pass 済み）。

---

## Fix-B: SettingsPanel.tsx のバリデーション UI 改善（高-1 + 低-2）

### 変更対象
- `src/components/SettingsPanel.tsx`

### 問題の詳細と影響分析

**高-1: キャンセル時にエラーが残る**

`SettingsPanel` は `App.tsx` の `<Dialog open={settingsOpen}>` 内で常にマウントされたまま（`open` prop で表示/非表示を制御）。`validationError` state は Dialog が閉じても保持される。現状の早期 return パターン:

```typescript
if (!selected) return;  // open() がキャンセルされると null を返す
```

この `return` により `setValidationError(null)` が呼ばれないため、前回のエラーが画面に残る。次回ダイアログを開いたとき（または同一セッション内でキャンセルを繰り返した後）、古いエラーが表示されたままになる。

**影響連鎖の確認:**
- `handleSelectFolder` は `handleAddGhostFolder` と完全に独立しており、追加フォルダ機能への波及なし
- `App.tsx` の `useEffect` は `sspPath` 変化を監視しているが、キャンセル時は `sspPath` が変わらないため影響なし
- `setValidationError(null)` はローカル state のみ変更。`onPathChange` は呼ばれない

**低-2: バリデーション中に追加ボタンが有効**

`validating=true` の間（`invoke("validate_ssp_path", ...)` の実行中）、「追加ゴーストフォルダ」ボタンが操作可能。`validate_ssp_path` は `ssp.exe` の存在確認のみで高速だが、UI の一貫性として `disabled` にすべき。

**影響連鎖の確認:**
- `handleAddGhostFolder` は `validating` state を参照しないため、`disabled` にしても `handleAddGhostFolder` の内部ロジックは変わらない
- `onAddFolder` は `useSettings.addGhostFolder` を呼ぶが、これも `validating` state と無関係
- バリデーション完了後（`finally { setValidating(false) }`）にすぐ有効化される

### 変更内容

**変更1（高-1）: キャンセル時のエラークリア**

```typescript
// Before
if (!selected) return;

// After
if (!selected) {
  setValidationError(null);
  return;
}
```

**変更2（低-2）: 追加ボタンの disabled 追加**

```tsx
// Before
<Button icon={<AddRegular />} appearance="secondary" onClick={handleAddGhostFolder}>
  追加
</Button>

// After
<Button icon={<AddRegular />} appearance="secondary" onClick={handleAddGhostFolder} disabled={validating}>
  追加
</Button>
```

### 検証

```bash
npm run build
```

TypeScript strict チェック（`tsc`）が通ることを確認。

---

## Fix-C: ghostCacheRepository のテスト拡充 + 型ガード強化（高-3 + 低-3）

### 変更対象
- `src/lib/ghostCacheRepository.ts`
- `src/lib/ghostCacheRepository.test.ts`

### 問題の詳細と影響分析

**低-3: isGhostCacheStoreV1 が配列を除外しない**

```typescript
typeof candidate.entries === "object"  // typeof [] === "object" が true になる
```

`entries: []` のようなデータが `settingsStore` に保存される可能性は実際には低いが、防御的プログラミングとして正しくない。`!Array.isArray(candidate.entries)` を追加することで型ガードが正確になる。

**影響連鎖の確認:**
- `isGhostCacheStoreV1` は `readGhostCacheStore` の中でのみ呼ばれる
- `readGhostCacheStore` は `settingsStore.get<unknown>(GHOST_CACHE_KEY)` の結果を検証する
- `entries: []` の場合、現状は `{version: 1, entries: []}` で型ガードをパスして `cacheStore.entries["key"]` が `undefined` を返す（配列への文字列キーアクセス）→ `readGhostCacheEntry` が `undefined` を返し、フルスキャンに落ちる。実害は軽微だが動作が不正確
- 修正後は `entries: []` の場合でも型ガードが `false` を返し、空の新規ストアにフォールバックする（同じ結果だが意図が明確）

**高-3: writeGhostCacheEntry / pruneOldEntries のテスト不足**

現在のテストは `isGhostCacheStoreV1` の型ガードのみ。以下がテストされていない:
1. `readGhostCacheEntry`: キャッシュミス（`undefined` を返すか）
2. `readGhostCacheEntry`: キャッシュヒット（正しい entry を返すか）
3. `writeGhostCacheEntry`: 書き込みが `settingsStore.set` + `save` を呼ぶか
4. `pruneOldEntries`: 11件書き込んだとき最古のものが削除されるか

**settingsStore シングルトンとテスト分離の設計:**

`settingsStore.ts` は `new LazyStore("settings.json")` をモジュールレベルで1回だけ実行する。vitest のエイリアスにより `@tauri-apps/plugin-store` がモック `LazyStore` に差し替えられているため、`settingsStore` はモックインスタンス。

モックの `LazyStore` は `private store: Record<string, any> = {}` を持つ。`vi.clearAllMocks()` は呼び出し履歴はリセットするが `store` の中身はリセットしない。テスト間の状態リークを防ぐには `store` を手動でリセットする必要がある:

```typescript
(settingsStore as unknown as { store: Record<string, unknown> }).store = {};
```

`cacheWriteQueue` はモジュールレベルの `let` 変数（export されていない）。各テストで `writeGhostCacheEntry` を `await` すれば前のキューが消費された状態で次のテストが始まるため、特別なリセットは不要。

**pruneOldEntries のテスト戦略:**

`pruneOldEntries` は `ghostCacheRepository.ts` から export されていない（モジュール private）。`writeGhostCacheEntry` 経由で間接的にテストする:
1. `settingsStore.set(GHOST_CACHE_KEY, { version: 1, entries: 10件のデータ })` でストアに事前注入
2. `await writeGhostCacheEntry("key-new", newestEntry)` を呼ぶ → 11件になりpruning が走る
3. `readGhostCacheEntry("key-new")` → 新エントリが存在することを確認
4. `readGhostCacheEntry("最古のキー")` → `undefined` を確認（削除されているはず）

`cached_at` ソートで古い順に削除するため、テストデータは異なる `cached_at` 値（1時間ずつずらす）で10件用意し、最古（`i=0`）が削除されることを確認する。

### 変更内容

**ghostCacheRepository.ts の変更（低-3）:**

```typescript
// Before
return (
  candidate.version === GHOST_CACHE_VERSION &&
  !!candidate.entries &&
  typeof candidate.entries === "object"
);

// After
return (
  candidate.version === GHOST_CACHE_VERSION &&
  !!candidate.entries &&
  typeof candidate.entries === "object" &&
  !Array.isArray(candidate.entries)
);
```

**ghostCacheRepository.test.ts の追記（高-3 + 低-3）:**

既存の `isGhostCacheStoreV1` テストに低-3 対応のケースを追加し、新たに `readGhostCacheEntry` / `writeGhostCacheEntry` + `pruneOldEntries` のテスト describe を追加する。

```typescript
// 追加するインポート
import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  isGhostCacheStoreV1,
  readGhostCacheEntry,
  writeGhostCacheEntry,
  GHOST_CACHE_KEY,
} from "./ghostCacheRepository";
import { settingsStore } from "./settingsStore";
import type { GhostCacheEntry } from "../types";

// settingsStore のインメモリ状態をリセットするヘルパー
function resetSettingsStore() {
  (settingsStore as unknown as { store: Record<string, unknown> }).store = {};
}
```

**isGhostCacheStoreV1 に追加するケース（低-3）:**
```typescript
it("entries が配列の場合 false を返す", () => {
  expect(isGhostCacheStoreV1({ version: 1, entries: [] })).toBe(false);
});
```

**readGhostCacheEntry のテスト（高-3）:**

```
describe("readGhostCacheEntry")
  beforeEach: vi.clearAllMocks() + resetSettingsStore()

  it("キャッシュが空のとき undefined を返す")
    → readGhostCacheEntry("nonexistent") → toBeUndefined()

  it("ストアに存在するキーの entry を返す")
    → settingsStore.set(GHOST_CACHE_KEY, {version:1, entries:{k: entry}})
    → readGhostCacheEntry("k") → toEqual(entry)
```

**writeGhostCacheEntry + pruneOldEntries のテスト（高-3）:**

```
describe("writeGhostCacheEntry")
  beforeEach: vi.clearAllMocks() + resetSettingsStore()

  it("エントリを書き込み settingsStore.save を呼ぶ")
    → await writeGhostCacheEntry("key", entry)
    → readGhostCacheEntry("key") → toEqual(entry)
    → expect(settingsStore.save).toHaveBeenCalledTimes(1)

  it("10件以内では削除しない")
    → 10件を事前注入
    → await writeGhostCacheEntry("key-new", newest)
    → readGhostCacheEntry("key-0") → toBeDefined()  // 削除されていないこと

  it("11件目を書き込むと最古のエントリが削除されて10件になる")
    → 10件（cached_at を1時間ずつずらす）を事前注入
    → await writeGhostCacheEntry("key-new", newest)
    → readGhostCacheEntry("key-new") → toBeDefined()
    → readGhostCacheEntry("key-0") → toBeUndefined()  // 最古が削除された
```

### 注意事項

- テストデータの `GhostCacheEntry.cached_at` は ISO 文字列形式（`new Date(...).toISOString()`）
- `pruneOldEntries` は `cached_at` を `new Date(b.cached_at).getTime()` でパースしているため、正しい ISO 文字列を使うこと
- `writeGhostCacheEntry` の内部で `readGhostCacheStore` → `settingsStore.get` の順で呼ばれる。`vi.clearAllMocks()` は `vi.fn()` の呼び出し履歴のみクリアし、実装は保持する。そのため `beforeEach` 後も `settingsStore.get/set/save` の実装は正常に動作する

### 検証

```bash
npm test
```

全テストが通ることを確認。

---

## Fix-D: vitest.config.ts に `.tsx` を追加（低-4）

### 変更対象
- `vitest.config.ts`

### 問題の詳細と影響分析

現状の `include: ["src/**/*.test.ts"]` は `.test.tsx` をカバーしない。React コンポーネント（JSX を含む）のテストは慣習的に `.test.tsx` 拡張子を使う。将来 `SettingsPanel.test.tsx` などを追加したとき自動的に検出されない。

**影響分析:**
- 現在 `.test.tsx` ファイルは存在しないため、この変更による既存テストへの影響は完全にゼロ
- vitest の `include` は glob パターンであり、`{ts,tsx}` は brace expansion として正しく解釈される

### 変更内容

```typescript
// Before
include: ["src/**/*.test.ts"],

// After
include: ["src/**/*.test.{ts,tsx}"],
```

### 検証

```bash
npm test  # 既存15件が引き続き通ることを確認
```

---

## Fix-E: fingerprint/scan のトークン重複解消 + ハッシュ関数シグネチャ修正（高-2 + 低-1）

### 変更対象
- `src-tauri/src/commands/ghost/fingerprint.rs`
- `src-tauri/src/commands/ghost/scan.rs`
- `src-tauri/src/commands/ghost/mod.rs`（テスト追加）

### 問題の詳細と影響分析

**高-2: missing/not-directory トークン生成の重複**

`fingerprint.rs` の `push_parent_fingerprint_tokens`（74-99行）と `scan.rs` の `scan_ghosts_with_fingerprint_internal`（150-163行）で、追加フォルダが存在しない/ディレクトリでない場合のトークン生成コードが重複している。

```rust
// fingerprint.rs（push_parent_fingerprint_tokens 内）
tokens.push(format!("parent|{}|{}|missing", parent_label, normalized_parent));
tokens.push(format!("parent|{}|{}|not-directory", parent_label, normalized_parent));

// scan.rs（scan_ghosts_with_fingerprint_internal 内）
tokens.push(format!("parent|{}|{}|missing", normalized_folder, normalized_folder));
tokens.push(format!("parent|{}|{}|not-directory", normalized_folder, normalized_folder));
```

現時点でフォーマットは一致しているが（`fingerprint.rs` では `parent_label = &normalized_folder`、`normalized_parent = normalize_path(folder_path) = normalized_folder` なので同値）、将来のどちらか一方の変更でフォーマットがズレるとキャッシュが永続的に無効化されるバグになる。`integrated_fingerprint_matches_standalone_build_fingerprint` テストはこの `missing`/`not-directory` パスを通らない（テスト用ディレクトリは実際に存在する）。

**修正アプローチの検討:**

`fingerprint.rs` に `pub(crate) fn push_absent_parent_token` を追加し、両ファイルからこの関数を呼ぶ。`push_entry_token` と同様の「共通ヘルパーに委譲」パターン。フォーマット文字列が一箇所に集約されるため、将来の変更点が自明になる。

**`push_absent_parent_token` の設計:**

引数: `tokens: &mut Vec<String>`, `parent_label: &str`, `normalized_parent: &str`, `state: &str`

`state` パラメータに `"missing"` または `"not-directory"` を渡す。文字列リテラルを引数にすることで、呼び出し元で意味が明示される。

**影響連鎖の確認（高-2）:**

- `fingerprint.rs` と `scan.rs` の両方が同じ `push_absent_parent_token` を呼ぶため、フォーマットの同一性が構造的に保証される
- `push_parent_fingerprint_tokens` の `required=true` パス（SSP フォルダ用）は `Err` を返すため、`push_absent_parent_token` は `required=false` パスでのみ呼ばれる
- 既存の6テストはすべて `exists()` かつ `is_dir()` が真のディレクトリを対象にしているため、`push_absent_parent_token` の追加による既存テストへの影響はなし
- **新テストが必要:** `missing` ケースで `build_fingerprint` と `scan_ghosts_with_fingerprint_internal` が同じハッシュを返すことを確認する

**低-1: compute_fingerprint_hash の破壊的ソート副作用**

```rust
pub(crate) fn compute_fingerprint_hash(tokens: &mut Vec<String>) -> String {
    tokens.sort();  // 呼び出し元の Vec を破壊的にソート
    ...
}
```

`&mut Vec<String>` シグネチャは「この関数は Vec を変更する」というコントラクトを暗示する。現在は呼び出し後に `tokens` を使わないため実害なしだが、シグネチャが意図を正確に伝えていない。

**修正案: `&[String]` に変更し内部でコピーをソート**

```rust
pub(crate) fn compute_fingerprint_hash(tokens: &[String]) -> String {
    let mut sorted = tokens.to_vec();
    sorted.sort();
    ...
}
```

**影響連鎖の確認（低-1）:**

- `to_vec()` による Vec の複製が生じる。トークン数はゴースト数 + 親ディレクトリ数に比例するため、通常数十件程度。パフォーマンス影響は軽微
- `build_fingerprint`（fingerprint.rs）の呼び出し: `compute_fingerprint_hash(&mut tokens)` → `compute_fingerprint_hash(&tokens)` に変更。`tokens` は `let mut` のままで問題なし（`push_*` 関数が `&mut tokens` を要求するため）
- `scan_ghosts_with_fingerprint_internal`（scan.rs）の呼び出し: `compute_fingerprint_hash(&mut tokens)` → `compute_fingerprint_hash(&tokens)` に変更
- 関数の `pub(crate)` 可視性は変わらないため、外部への影響なし

**Fix-E 実施順序:**

1. `fingerprint.rs`: `push_absent_parent_token` 追加 → `compute_fingerprint_hash` シグネチャ変更 → `push_parent_fingerprint_tokens` で `push_absent_parent_token` を使うよう更新 → `build_fingerprint` の呼び出しを `&tokens` に変更
2. `scan.rs`: インポートに `push_absent_parent_token` 追加 → `missing`/`not-directory` の2箇所を `push_absent_parent_token` に委譲 → `compute_fingerprint_hash` 呼び出しを `&tokens` に変更
3. `mod.rs`: `missing` フォルダで `build_fingerprint` と scan が一致することを確認するテストを追加

### 変更内容

#### Step 1: fingerprint.rs

**追加する関数 `push_absent_parent_token`（`push_entry_token` の直前に配置）:**

```rust
/// 追加フォルダが存在しない・ディレクトリでない場合の親エントリトークンを生成する。
/// scan.rs と fingerprint.rs の共通ロジック。
/// state: "missing" または "not-directory"
pub(crate) fn push_absent_parent_token(
    tokens: &mut Vec<String>,
    parent_label: &str,
    normalized_parent: &str,
    state: &str,
) {
    tokens.push(format!("parent|{}|{}|{}", parent_label, normalized_parent, state));
}
```

**`compute_fingerprint_hash` のシグネチャ変更:**

```rust
// Before
pub(crate) fn compute_fingerprint_hash(tokens: &mut Vec<String>) -> String {
    tokens.sort();

// After
pub(crate) fn compute_fingerprint_hash(tokens: &[String]) -> String {
    let mut sorted = tokens.to_vec();
    sorted.sort();
    // 以降 tokens.iter() → sorted.iter() に変更
```

**`push_parent_fingerprint_tokens` 内の `missing`/`not-directory` を委譲:**

```rust
// Before
tokens.push(format!("parent|{}|{}|missing", parent_label, normalized_parent));
// After
push_absent_parent_token(tokens, parent_label, &normalized_parent, "missing");

// Before
tokens.push(format!("parent|{}|{}|not-directory", parent_label, normalized_parent));
// After
push_absent_parent_token(tokens, parent_label, &normalized_parent, "not-directory");
```

**`build_fingerprint` の呼び出し変更:**

```rust
// Before
Ok(compute_fingerprint_hash(&mut tokens))
// After
Ok(compute_fingerprint_hash(&tokens))
```

#### Step 2: scan.rs

**インポートに `push_absent_parent_token` を追加:**

```rust
// Before
use super::fingerprint::{
    compute_fingerprint_hash, metadata_modified_string, push_entry_token,
};

// After
use super::fingerprint::{
    compute_fingerprint_hash, metadata_modified_string, push_absent_parent_token, push_entry_token,
};
```

**追加フォルダループの委譲:**

```rust
// Before
if !folder_path.exists() {
    tokens.push(format!("parent|{}|{}|missing", normalized_folder, normalized_folder));
    continue;
}
if !folder_path.is_dir() {
    tokens.push(format!("parent|{}|{}|not-directory", normalized_folder, normalized_folder));
    continue;
}

// After
if !folder_path.exists() {
    push_absent_parent_token(&mut tokens, &normalized_folder, &normalized_folder, "missing");
    continue;
}
if !folder_path.is_dir() {
    push_absent_parent_token(&mut tokens, &normalized_folder, &normalized_folder, "not-directory");
    continue;
}
```

**`compute_fingerprint_hash` 呼び出し変更:**

```rust
// Before
let fingerprint = compute_fingerprint_hash(&mut tokens);
// After
let fingerprint = compute_fingerprint_hash(&tokens);
```

#### Step 3: mod.rs のテスト追加

追加するテスト（既存の `integrated_fingerprint_matches_standalone_build_fingerprint` の直後に追加）:

```rust
#[test]
fn fingerprint_with_missing_additional_folder_matches_scan_fingerprint() -> Result<(), String> {
    let workspace = TempDirGuard::new("ghost_launcher_missing_folder_fp_test")?;
    let ssp_root = workspace.path().join("ssp");
    let ssp_ghost = ssp_root.join("ghost");
    fs::create_dir_all(&ssp_ghost)
        .map_err(|error| format!("failed to create ssp ghost dir: {}", error))?;
    create_ghost_dir(&ssp_ghost, "test_ghost")?;

    // 存在しない追加フォルダ（missing ケース）
    let nonexistent = workspace.path().join("nonexistent_folder");
    // 存在するがファイル（not-directory ケース）
    let not_a_dir = workspace.path().join("not_a_dir.txt");
    fs::write(&not_a_dir, "")
        .map_err(|error| format!("failed to create file: {}", error))?;

    let additional_folders = vec![
        nonexistent.to_string_lossy().to_string(),
        not_a_dir.to_string_lossy().to_string(),
    ];
    let ssp_path = ssp_root.to_string_lossy().to_string();

    let standalone = build_fingerprint(&ssp_path, &additional_folders)?;
    let (_, integrated) =
        scan_ghosts_with_fingerprint_internal(&ssp_path, &additional_folders)?;

    assert_eq!(standalone, integrated);
    Ok(())
}
```

### 検証

```bash
cargo test
# 新テストを含む7件すべてが通ることを確認
```

---

## Fix-F: script-src 'unsafe-inline' の実機確認（中-1）

### 変更対象
- なし（実機確認のみ）

### 確認手順

```bash
npm run tauri dev
```

アプリ起動後:
1. WebView の開発者ツールを開く（Tauri 開発モードでは F12 または右クリック→検証）
2. Console タブで CSP 関連エラー（`Content Security Policy violation`）がないことを確認
3. 設定パネルを開く・閉じる・フォルダ選択をキャンセルするなど一通り操作する

**結果に応じた対応:**

| 確認結果 | 対応 |
|----------|------|
| `script-src` 関連の CSP エラーが出ない | `tauri.conf.json` の `script-src` から `'unsafe-inline'` を削除して再確認 |
| `script-src` 関連の CSP エラーが出る | `'unsafe-inline'` を維持。コメントに「Tauri 2 のインジェクトスクリプトに必要」と記録 |
| `style-src` 関連の CSP エラーが出る | Griffel の要件のため `'unsafe-inline'` を必ず維持 |

**注意:** `script-src 'unsafe-inline'` を削除する場合は `npm run tauri build` でビルドした本番バイナリでも確認すること。開発モードと本番ビルドで Tauri の動作が異なる場合がある。

---

## 変更ファイル一覧

| Fix | ファイル | 変更種別 |
|-----|---------|---------|
| Fix-A | `.github/workflows/ci-build.yml` | 修正（1行）|
| Fix-B | `src/components/SettingsPanel.tsx` | 修正（3行）|
| Fix-C | `src/lib/ghostCacheRepository.ts` | 修正（1行）|
| Fix-C | `src/lib/ghostCacheRepository.test.ts` | 修正（テスト大幅追加）|
| Fix-D | `vitest.config.ts` | 修正（1行）|
| Fix-E | `src-tauri/src/commands/ghost/fingerprint.rs` | 修正（関数追加・シグネチャ変更）|
| Fix-E | `src-tauri/src/commands/ghost/scan.rs` | 修正（インポート・2箇所の委譲・呼び出し変更）|
| Fix-E | `src-tauri/src/commands/ghost/mod.rs` | 修正（テスト追加）|
| Fix-F | — | 変更なし（実機確認のみ）|

---

## 対応しない指摘

| ID | 理由 |
|----|------|
| 中-2（push_entry_token の SRP 混在） | コメントで意図を説明済み。KISS/DRY のトレードオフとして許容範囲。変更により生まれる複雑さの方が大きい |
| 低-5（ssp.exe チェックの重複） | CLAUDE.md 方針「2回まで許容、3回目で抽出」を適用。2箇所であり増加時に再評価する |
| 中-4（buildRequestKey のエッジケース） | Windows パスに `\|` は使用不可であり実害なし。現状テストで十分 |
