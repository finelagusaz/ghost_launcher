# ドリフト防御 三点バッチ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** IPC 型を codegen 単一源化し、検索正規化を言語間パリティテストで縛り、CI で codegen 再生成を照合して、観測済みのドリフト 3 種を構造的に塞ぐ。

**Architecture:** (A) フロントが ts-rs 生成型を import（手書き重複を削除、Rust→TS の一本道）。(B) ゴールデン fixture を JS/Rust 両テストが参照（消せない冗長性を機械的に縛る）。(C) `cargo test` 後に生成物の未コミット差分を CI で検出。

**Tech Stack:** Tauri 2（Rust / rusqlite / ts-rs / unicode-normalization / serde_json）、React 19 / TypeScript、Vitest、GitHub Actions。

## Global Constraints

- 設計書: `docs/superpowers/specs/2026-06-21-drift-hardening-design.md`（本プランの根拠）。
- ブランチ: `refactor/drift-hardening`（マージ済み main の上に rebase 済み。#81 request_key 単一権威化・#82 ScanGhostsResponse 解消を含む）。
- IPC 規約: `invoke()` 引数は camelCase→snake_case 変換、戻り値フィールド名は変換されない（snake_case のまま）。
- ts-rs: IPC struct に `#[cfg_attr(test, derive(TS))]` + `#[cfg_attr(test, ts(export))]`。`cargo test` 実行時に `src/types/generated/` へ TS を生成。手書き TS 型を定義しない。
- TDD / DRY / YAGNI / 頻繁なコミット。
- コミットメッセージ末尾に必ず付与: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- コミット前チェックリスト: `npm run build` / `npm test` / `npm run check:ui-guidelines` / `npm run test:ui-guidelines-check` / `cargo test --manifest-path src-tauri/Cargo.toml`。

---

## File Structure

| ファイル | 責務 | 変更 |
|---|---|---|
| `src-tauri/src/commands/ghost/types.rs` | `Ghost` から ts-rs export 削除（脱 IPC）。`ScanStoreResult` は export 維持 | 修正 |
| `src/types/generated/Ghost.ts` | 不要な生成物 | 削除 |
| `src/lib/dbMonitor.ts` | 手書き `ScanStoreResult` を生成型の re-export に置換 | 修正 |
| `src/test/fixtures/normalize-key-cases.json` | NFKC+小文字化の入力→期待値ゴールデン fixture | 新規 |
| `src/lib/ghostDatabase.ts` | `normalizeForKey` を export | 修正 |
| `src/lib/ghostDatabase.test.ts` | JS パリティテスト | 新規 |
| `src-tauri/src/commands/ghost/store.rs` | 既存 inline テストを fixture 駆動の Rust パリティテストに置換 | 修正 |
| `.github/workflows/ci-build.yml` | codegen 照合ステップ追加 | 修正 |

PR 構成: A・B・C を単一 PR にまとめる（小規模・「ドリフト防御」で一貫）。

---

## Task 1: IPC 型を codegen 単一源へ（A）

**Files:**
- Modify: `src-tauri/src/commands/ghost/types.rs`
- Delete: `src/types/generated/Ghost.ts`
- Modify: `src/lib/dbMonitor.ts`

**Interfaces:**
- Produces: フロントが `ScanStoreResult` を `src/types/generated/ScanStoreResult.ts`（ts-rs 生成）由来で取得する状態。`dbMonitor.ts` は `export type { ScanStoreResult }` で再公開し、消費側（`ghostCatalogService.ts`）の `import ... from "./dbMonitor"` を不変に保つ。
- Note: 振る舞い不変（型の出所変更）。新規テストは無し。検証は既存テスト＋ビルド＋生成物状態で行う。`Ghost` はどのコマンドも返さず IPC を渡らないため export 不要（`grep -rn "types/generated" src` が 0 件、`scan_and_store` の戻りは `ScanStoreResult` のみ）。

- [ ] **Step 1: `Ghost` struct から ts-rs export を削除**

`src-tauri/src/commands/ghost/types.rs` の `Ghost` struct（5-8 行付近）の属性を変更:

変更前:
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export))]
pub struct Ghost {
```
変更後:
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ghost {
```

`ScanStoreResult` struct（35-38 行付近）の `#[cfg_attr(test, derive(TS))]` + `#[cfg_attr(test, ts(export))]` は**残す**。`#[cfg(test)] use ts_rs::TS;`（3 行）も `ScanStoreResult` の derive が使うため残す。

- [ ] **Step 2: 生成物 `Ghost.ts` を削除**

```bash
git rm src/types/generated/Ghost.ts
```

- [ ] **Step 3: `dbMonitor.ts` の手書き型を生成型の re-export へ置換**

`src/lib/dbMonitor.ts` の 1 行目付近（import 群）に追加し、手書き interface（10-15 行）を削除する。

変更前（10-15 行）:
```ts
export interface ScanStoreResult {
  cache_hit: boolean;
  total: number;
  fingerprint: string;
  request_key: string;
}
```
変更後（同位置）:
```ts
import type { ScanStoreResult } from "../types/generated/ScanStoreResult";
export type { ScanStoreResult };
```

（`reportScanComplete(result: ScanStoreResult, ...)` は import した型をそのまま使う。`ghostCatalogService.ts:5` の `import type { ScanStoreResult } from "./dbMonitor"` は再公開により不変。）

- [ ] **Step 4: Rust テストとビルドで検証**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS（既存テスト全通過。特に `ghost_の_json_フィールド名が_ts_型と一致する` が serde ベースで通る。未使用 import 警告が無いこと）。

Run: `ls src/types/generated/`
Expected: `ScanStoreResult.ts` のみ（`Ghost.ts` は再生成されない）。

- [ ] **Step 5: フロントのビルドとテストで検証**

Run: `npm run build`
Expected: PASS（tsc が `dbMonitor.ts` 経由で生成型 `ScanStoreResult` を解決。型不一致やパス解決エラーが無いこと）。

Run: `npm test`
Expected: PASS（回帰なし）。

- [ ] **Step 6: コミット**

```bash
git add src-tauri/src/commands/ghost/types.rs src/lib/dbMonitor.ts src/types/generated/Ghost.ts
git commit -m "refactor: IPC 型 ScanStoreResult を ts-rs 生成型に一本化し未使用 Ghost 生成を撤去"
```

---

## Task 2: 検索正規化のパリティテスト（B）

**Files:**
- Create: `src/test/fixtures/normalize-key-cases.json`
- Modify: `src/lib/ghostDatabase.ts`
- Create: `src/lib/ghostDatabase.test.ts`
- Modify: `src-tauri/src/commands/ghost/store.rs`

**Interfaces:**
- Consumes: 共有 fixture `src/test/fixtures/normalize-key-cases.json`（`[{ "input": string, "expected": string }]`、expected = NFKC 正規化 + 小文字化）。
- Produces: JS `export function normalizeForKey(value: string): string`（`ghostDatabase.ts`）。Rust `normalize_for_key` は `store.rs` 内 private のまま同モジュールのテストが参照。
- Note: 両実装は既に一致（共に NFKC+小文字化）するため、テストは初回から緑になる。価値は**将来どちらかがずれたら Red になる**回帰防御。Step 5 で一方を一時的に壊して Red を確認し、テストが実際に効くことを証明する。

- [ ] **Step 1: ゴールデン fixture を作成**

`src/test/fixtures/normalize-key-cases.json`:
```json
[
  { "input": "ABC", "expected": "abc" },
  { "input": "Ａｌｉｃｅ", "expected": "alice" },
  { "input": "HELLO", "expected": "hello" },
  { "input": "ｱ", "expected": "ア" },
  { "input": "ﬁ", "expected": "fi" },
  { "input": "が", "expected": "が" },
  { "input": "が", "expected": "が" },
  { "input": "テスト", "expected": "テスト" },
  { "input": "", "expected": "" }
]
```
（`ｱ` は半角カナ U+FF71 → NFKC で全角 `ア`。`ﬁ` は合字 U+FB01 → `fi`。`が` は NFD 分解形 → NFKC で合成 `が`。NFKC が実際に作用するケースを含む。）

- [ ] **Step 2: `normalizeForKey` を export**

`src/lib/ghostDatabase.ts` の 82 行目を変更:

変更前:
```ts
function normalizeForKey(value: string): string {
```
変更後:
```ts
export function normalizeForKey(value: string): string {
```

- [ ] **Step 3: JS パリティテストを作成**

`src/lib/ghostDatabase.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import cases from "../test/fixtures/normalize-key-cases.json";
import { normalizeForKey } from "./ghostDatabase";

describe("normalizeForKey パリティ（共有 fixture）", () => {
  it.each(cases)("normalizeForKey($input) === $expected", ({ input, expected }) => {
    expect(normalizeForKey(input)).toBe(expected);
  });
});
```

- [ ] **Step 4: JS テストを実行して通ることを確認**

Run: `npx vitest run src/lib/ghostDatabase.test.ts`
Expected: PASS（9 ケース）。

- [ ] **Step 5: Rust パリティテストへ置換**

`src-tauri/src/commands/ghost/store.rs` の既存テスト `normalize_for_key_が_nfkc_正規化と小文字化を行う()`（423-429 行）を、fixture 駆動に置換する（インラインの期待値を fixture に一本化＝DRY）:

変更前:
```rust
    #[test]
    fn normalize_for_key_が_nfkc_正規化と小文字化を行う() {
        assert_eq!(normalize_for_key("Ａｌｉｃｅ"), "alice");
        assert_eq!(normalize_for_key("HELLO"), "hello");
        assert_eq!(normalize_for_key("テスト"), "テスト");
        assert_eq!(normalize_for_key(""), "");
    }
```
変更後:
```rust
    #[test]
    fn normalize_for_key_が共有_fixture_の期待値と一致する() {
        // JS の normalizeForKey と同一の fixture を参照し、言語間パリティを縛る。
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/test/fixtures/normalize-key-cases.json"
        );
        let raw = std::fs::read_to_string(path).expect("fixture を読めること");
        let cases: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
        for case in cases {
            let input = case["input"].as_str().unwrap();
            let expected = case["expected"].as_str().unwrap();
            assert_eq!(normalize_for_key(input), expected, "input={input:?}");
        }
    }
```

- [ ] **Step 6: Rust テストを実行して通ることを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml normalize_for_key`
Expected: PASS。

- [ ] **Step 7: テストが実際にドリフトを捕まえることを確認（Red 証明 → 復帰）**

`store.rs` の `normalize_for_key` を一時的に壊す（`.to_lowercase()` を外す）:
```rust
fn normalize_for_key(s: &str) -> String {
    s.nfkc().collect::<String>()
}
```
Run: `cargo test --manifest-path src-tauri/Cargo.toml normalize_for_key`
Expected: FAIL（`"HELLO"` 等で不一致）。確認後、`.to_lowercase()` を**元に戻す**:
```rust
fn normalize_for_key(s: &str) -> String {
    s.nfkc().collect::<String>().to_lowercase()
}
```
Run: 再度 `cargo test ... normalize_for_key` → PASS に戻ることを確認。

- [ ] **Step 8: コミット**

```bash
git add src/test/fixtures/normalize-key-cases.json src/lib/ghostDatabase.ts src/lib/ghostDatabase.test.ts src-tauri/src/commands/ghost/store.rs
git commit -m "test: 検索正規化(NFKC+小文字化)の言語間パリティを共有 fixture で縛る"
```

---

## Task 3: CI で codegen を照合（C）

**Files:**
- Modify: `.github/workflows/ci-build.yml`

**Interfaces:**
- Consumes: Task 1 で `generated/` が `ScanStoreResult.ts` のみになった状態。
- Note: A で codegen が load-bearing になったため、再生成結果が commit 済みと一致することを CI で強制する。

- [ ] **Step 1: 照合ステップを追加**

`.github/workflows/ci-build.yml` の `Test Rust crates`（`cargo test --workspace`）ステップの**直後**に追加する:

```yaml
      - name: Verify generated types are committed
        shell: bash
        run: |
          git diff --exit-code src/types/generated/
          test -z "$(git ls-files --others --exclude-standard src/types/generated/)"
```

（`cargo test --workspace` が ts-rs 生成を走らせた後に実行する。tracked な差分＝再生成忘れ、untracked な新規＝リネーム漏れを検出する。）

- [ ] **Step 2: ローカルで照合コマンドが clean tree で通ることを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`（生成を走らせる）
Run: `git diff --exit-code src/types/generated/ && test -z "$(git ls-files --others --exclude-standard src/types/generated/)" && echo OK`
Expected: `OK`（生成物が commit 済みと一致、未追跡ファイル無し）。

- [ ] **Step 3: コミット**

```bash
git add .github/workflows/ci-build.yml
git commit -m "ci: ts-rs 生成型が commit 済みと一致することを検証するステップを追加"
```

---

## Task 4: 統合検証

**Files:** なし（検証のみ）

- [ ] **Step 1: コミット前チェックリスト全項目**

```bash
npm run build
npm test
npm run check:ui-guidelines
npm run test:ui-guidelines-check
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path crates/ghost-meta/Cargo.toml
```
Expected: すべて PASS。

- [ ] **Step 2: 生成物の最終状態を確認**

Run: `ls src/types/generated/ && grep -rn "types/generated" src/lib/`
Expected: `ScanStoreResult.ts` のみ存在し、`dbMonitor.ts` が `types/generated/ScanStoreResult` を import している（生成型が実際に使われている）。

- [ ] **Step 3: `git status` が clean であることを確認**

```bash
git status
```
Expected: nothing to commit, working tree clean。

---

## Self-Review（作成者チェック済み）

- **Spec coverage**: A → Task 1、B → Task 2、C → Task 3、テスト方針 → 各 Task ＋ Task 4。設計のスコープ外（request_key・孤児網羅検出・Ghost/GhostView 整理）は本プランでも触れない。全項目に対応タスクあり。
- **Placeholder scan**: 各コード手順に実コードを記載。fixture・テスト・CI YAML すべて具体値。
- **Type consistency**: `ScanStoreResult`（Task 1 で生成型に一本化）、`normalizeForKey`（Task 2 で export）、`normalize_for_key`（Task 2 で fixture 駆動）、fixture 形式 `[{input, expected}]`（Task 2 の JS/Rust 双方で一致）。
- **既知の前提**: 本ブランチは #81/#82 を含むマージ済み main 上にある（rebase 済み）。
