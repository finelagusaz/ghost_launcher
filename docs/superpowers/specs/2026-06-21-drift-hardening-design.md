# ドリフト防御の三点バッチ 設計書

- 日付: 2026-06-21
- 種別: リファクタリング / テスト基盤（ドリフト防御）
- 前提: **PR #81（request_key 単一権威化）と #82（ScanGhostsResponse ドリフト解消）がマージ済みであること。** 本作業は両者と同じファイル群（`src/types/generated/`・`store.rs` 等）に触れるため、マージ後の `main` から派生ブランチで実装する。本設計書のコミットのみ先行する。

## 背景

ドリフト＝**強制されない冗長性**（同じ事実が二箇所以上にあり、一致が機械的に強制されていない）。本リポジトリで実際に観測された 3 つの未対策箇所を塞ぐ。

1. **IPC 型の二重源**: ts-rs が `src/types/generated/{Ghost,ScanStoreResult}.ts` を生成するが**どこからも import されていない**（`grep -r "types/generated" src` → 0 件）。実際に使われる `ScanStoreResult` は手書き（`dbMonitor.ts:10-15`）。codegen が安全性ゼロで存在し、手書きと将来ずれうる。
2. **検索正規化の言語間二重実装**: `normalizeForKey`（JS、`ghostDatabase.ts:82`、`value.normalize("NFKC").toLowerCase()`）と `normalize_for_key`（Rust、`store.rs:11`、`s.nfkc().collect::<String>().to_lowercase()`）。検索クエリの正規化（JS）と `_lower` 列の正規化（Rust）が一致しないと検索がヒットしない。源を一本化できない（検索は Rust を経由せず直接 SQL を読む）。
3. **codegen が CI で照合されない**: `ci-build.yml` の `cargo test --workspace` が ts-rs 生成を走らせるが、生成物が commit 済みと一致するかを検証していない。

## 決定

- **A. IPC 型を codegen 単一源にする**（#1）。Rust struct → ts-rs → TS で導出し、フロントは生成型を import する。
- **B. 検索正規化のパリティテスト**（#2）。源を一本化できないため、ゴールデン fixture で両実装の一致を機械的に縛る。
- **C. CI で codegen を照合する**（#3）。A で codegen が load-bearing になるため、再生成結果が commit 済みと一致することを CI で強制する。

設計原則: **消せる冗長性は消す（A）。消せない冗長性はテストで縛る（B）。導出物は再生成照合で守る（C）。**

## A. IPC 型を codegen 単一源へ

### 変更

- **`ScanStoreResult`（生きた IPC 型）**: `src/lib/dbMonitor.ts` の手書き `export interface ScanStoreResult {...}`（10-15 行）を削除し、生成型を re-export する:
  ```ts
  import type { ScanStoreResult } from "../types/generated/ScanStoreResult";
  export type { ScanStoreResult };
  ```
  消費側 `ghostCatalogService.ts:5`（`import type { ScanStoreResult } from "./dbMonitor"`）の import パスは不変。`dbMonitor.ts` 内の `reportScanComplete(result: ScanStoreResult, ...)` も同型を使う。
- **`Ghost`（もう IPC を渡らない）**: `src-tauri/src/commands/ghost/types.rs` の `Ghost` struct から `#[cfg_attr(test, derive(TS))]` と `#[cfg_attr(test, ts(export))]` を削除する。`Serialize`/`Deserialize` は残す（scan/DB 書き込みに必要）。生成物 `src/types/generated/Ghost.ts` を削除する。
- `ScanStoreResult` struct は `#[ts(export)]` を維持（フロントが import する唯一の生成型になる）。`use ts_rs::TS` は `ScanStoreResult` の derive が残るため必要。
- 既存テスト `ghost_の_json_フィールド名が_ts_型と一致する`（`types.rs`）は **serde ベース**（生成 TS に依存しない）で DB 列マッピングを守るため維持する。

### 不変条件

- `generated/` は実際に import される `ScanStoreResult.ts` のみを含む（未使用生成物が無い状態）。
- `ScanStoreResult` の TS 型は Rust struct から導出されるため、二つ目の源が存在せずドリフト不能。

## B. 検索正規化のパリティテスト

### fixture

`src/test/fixtures/normalize-key-cases.json` を新設。配列で `{ "input": string, "expected": string }`（expected = NFKC 正規化 + 小文字化）。NFKC が実際に作用するケースを必ず含める:

- 大文字 ASCII（`"ABC"` → `"abc"`）
- 全角ラテン（`"Ａ"` → `"ａ"`）
- 半角カナ（`"ｱ"` → `"ア"`、NFKC が全角へ畳む）
- 合字（`"ﬁ"` → `"fi"`）
- 合成済み/分解（NFC/NFD、例: `"が"` の 1 コードポイント版と `"か"+濁点` 版が同一出力）
- 日本語（`"ゴースト"` → 不変）
- 空文字（`""` → `""`）

期待値は NFKC+小文字化の定義から一意に決まるものを記載する。

### テスト

- **JS**: `normalizeForKey` を `ghostDatabase.ts` から **export** する（現在 module-private）。`src/lib/ghostDatabase.test.ts`（無ければ新設）で fixture を import し、各 `expect(normalizeForKey(input)).toBe(expected)`。
- **Rust**: `store.rs` の `#[cfg(test)] mod tests` 内（`normalize_for_key` は同モジュールなので private のまま参照可）で、fixture を `std::fs::read_to_string(format!("{}/../src/test/fixtures/normalize-key-cases.json", env!("CARGO_MANIFEST_DIR")))` で読み、`serde_json` でパースして各 `assert_eq!(normalize_for_key(&input), expected)`。`serde_json` は既に dev で利用可（`types.rs` テストが使用）。

両テストが同一 fixture の expected を参照するため、どちらかの実装がずれれば該当言語のテストが Red になる。

## C. CI の codegen 照合

`ci-build.yml` の `Test Rust crates`（`cargo test --workspace`、生成を走らせる）の直後にステップを追加:

```yaml
- name: Verify generated types are committed
  run: |
    git diff --exit-code src/types/generated/
    test -z "$(git ls-files --others --exclude-standard src/types/generated/)"
  shell: bash
```

- `git diff --exit-code`: tracked な生成ファイルが再生成で変化した（= struct 変更を commit し忘れた）場合に失敗。
- `git ls-files --others`: リネーム等で新規生成ファイルが untracked で出た場合に失敗。
- **限界**: struct を削除しただけで残る純粋な孤児（新ファイルを伴わない）は捕捉できない。これは稀なケースで、検出は ts-prune/knip 等の別手段（本設計のスコープ外）。

## テスト方針

- A: 振る舞い不変（型の出所が変わるだけ）。`npm run build`（tsc が生成型 import を検証）+ 既存テスト緑で担保。`cargo test`（Ghost の derive 削除後に未使用警告が出ないこと、`ghost_の_json_...` テストが通ること）。
- B: 新規パリティテスト（JS + Rust）。fixture 駆動。
- C: CI 設定変更。テストは追加しない（CI ワークフロー自体が検証手段）。

## スコープ外（YAGNI）

- `request_key` のドリフトは PR #81 で単一権威化済み。本件は触れない。
- `ScanStoreResult` への別途パリティテストは**不要**（codegen 単一源のため二つ目の源が無く、C の再生成照合で十分）。
- 孤児生成物の網羅的検出（ts-prune/knip 導入）は別件。
- `Ghost`/`GhostView` の関係整理（読み取り投影 vs 書き込み型）は IPC ドリフトとは別の関心事のため触れない。

## PR 構成

A・B・C は小さく、いずれも「ドリフト防御」で一貫するため**単一 PR**にまとめる。A と C は結合（A で codegen が load-bearing になり C が番人になる）。B は独立だが同 PR で構わない。

## 却下した代替案

- **B 方向（codegen を捨て手書き＋パリティ）**: ts-rs export と生成ディレクトリを撤去し `ScanStoreResult` も手書き＋パリティで縛る案。ツールチェインは単純化するが、自動導出の安全性を捨て手保守が残るため却下（codegen を「使う」方が単一源として強い）。
