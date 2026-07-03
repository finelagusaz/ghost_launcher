# アーキテクチャ診断 残課題手当て 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2026-07-03 のアーキテクチャ診断で検出した残課題（優先 3〜5 + 中重大度の負債）を、3 本の独立した PR で解消する。

**Architecture:** PR-1 は「意図と実装の乖離」の解消（ゴミファイル・死んだ API・冗長処理・相互依存・単一入口迂回）。PR-2 は振る舞いの修正と防御（random ソートの安定シード化・IPC ラッパー対称化・未テスト中核ロジックのテスト補強）。PR-3 は SPEC.md を「意図の粒度」へ再構成し実装ミラー記述を削減する（ユーザー承認済み方針）。

**Tech Stack:** Tauri 2 / Rust（rusqlite, rayon）+ React 19 / TypeScript + vitest + cargo test

## Global Constraints

- ブランチ名は `{prefix}/{issue番号}-{英語説明}`。各 PR の冒頭タスクで issue を発番し、その番号を使う
- コミット前チェックリスト（CLAUDE.md）: `npm run build` / `npm test` / `npm run check:ui-guidelines` / `npm run test:ui-guidelines-check` / `cargo test --workspace` / `git status` clean
- **push は SSH 不可**。`git -c credential.helper= -c credential.helper='!gh auth git-credential' push https://github.com/finelagusaz/ghost_launcher.git HEAD:<branch>` を使う（メモリ `git-push-ssh-broken-use-gh-https` 参照）
- マージは `gh pr merge <N> --squash`（`--delete-branch` 禁止）。後始末はメモリ記載の update-ref 手順
- コミットメッセージ末尾: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- `request_key` は JS 単一権威（`ghostScanUtils.ts`）。Rust 側での再計算を導入しない
- マイグレーション SQL には一切触れない（チェックサム不変性）
- UI 操作に関わる変更（PR-2）はマージ前に `npm run e2e` のローカル手動実行が必要（メモリ `e2e-run-in-this-env` の環境変数指定を参照）

## 非目標（今回は手当てしない）

| 項目 | 理由 |
|------|------|
| スキャン完了→再クエリの loading エッジ検出結合（useAppShellState） | 動作は正しく、再設計はリスク対効果が見合わない |
| SSP パス・言語の保存失敗が UI 無通知（useSettings の非対称） | UX 判断を要する。必要なら別 issue |
| TempDirGuard の二重定義 | テスト専用・クレート跨ぎ共有は構造上困難と診断済み |
| has_migration_conflict の文字列分割ヒューリスティック | キャッシュ DB 自動復旧の限定用途で許容と診断済み |
| docs/superpowers/ の旧設計スナップショット | 実装と矛盾なし。完了済み作業の設計根拠として残置 |

---

# PR-1: コード衛生 — 意図と実装の乖離解消

### Task 1-0: issue 発番とブランチ作成

**Files:** なし（git 操作のみ）

- [ ] **Step 1: issue を作成**

```bash
gh issue create --title "コード衛生: ゴミファイル・死んだ API・冗長ソート・モジュール相互依存・request_key 単一入口迂回の解消" --body "アーキテクチャ診断のフォローアップ。src-tauri/2 と check_out.txt の削除、ghost-meta::scan_ghosts の削除、scan.rs の冗長 name ソート削除、Ghost の serde 残滓整理、unique_sorted_additional_folders の path_utils 移設、scanInputsFromSettings 単一入口化。

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

発番された番号を以降 `{N1}` と表記する。

- [ ] **Step 2: ブランチ作成**

```bash
git status --short   # clean を確認
git switch -c refactor/{N1}-code-intent-cleanup
```

### Task 1-1: コミット済みゴミファイルの削除

**Files:**
- Delete: `src-tauri/2`（npm audit 出力 223B）
- Delete: `src-tauri/check_out.txt`（放棄実装の cargo check ログ 9.6KB）

**テスト追加なしの理由:** ファイル削除のみ。ビルド・テスト全体が回帰検証になる（コミットメッセージに明記）。

- [ ] **Step 1: 削除してコミット**

```bash
git rm src-tauri/2 src-tauri/check_out.txt
git commit -m "chore: 誤コミットされたゴミファイル 2 件を削除 (#{N1})

src-tauri/2 は npm audit の出力、check_out.txt は放棄された実装の
cargo check エラーログ。いずれも成果物ではない。
ファイル削除のみのためテスト追加は不適用。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 1-2: 死んだ公開 API `ghost_meta::scan_ghosts` の削除

**Files:**
- Modify: `crates/ghost-meta/src/lib.rs:16-17`（re-export 削減）
- Modify: `crates/ghost-meta/src/ghost.rs:70-92`（`scan_ghosts` 削除）+ 同ファイル tests 内の `scan_ghosts` 使用テスト削除

**Interfaces:**
- Produces: `ghost_meta` の公開 API は `read_ghost` / `GhostMeta` / thumbnail 系のみになる（`parse_descript` は使用実態を確認して判断）

**テスト方針:** 削除リファクタリング。Red は書けない（削除対象を使う本番コードが存在しないことが前提条件）。前提の検証を Step 1 の grep で行う。

- [ ] **Step 1: 使用実態の確認（前提検証）**

```bash
grep -rn "scan_ghosts" --include="*.rs" src-tauri/ crates/ghost-meta/src/
grep -rn "ghost_meta::parse_descript\|use ghost_meta::{[^}]*parse_descript" --include="*.rs" src-tauri/
```

期待: `scan_ghosts` のヒットは `crates/ghost-meta/src/ghost.rs`（定義と自己テスト）と `lib.rs`（re-export）のみ。`parse_descript` の src-tauri ヒットは 0 件。
**ヒットが期待と異なる場合は削除を中止し、使用箇所を報告して判断を仰ぐ。**

- [ ] **Step 2: ghost.rs から `scan_ghosts` 関数（70-92 行）と、tests モジュール内で `scan_ghosts` を呼ぶテストを削除**

- [ ] **Step 3: lib.rs の re-export を更新**

```rust
pub use ghost::{read_ghost, GhostMeta};
```

`parse_descript` の re-export（`pub use descript::parse_descript;`）は Step 1 で src-tauri 使用 0 件を確認できた場合のみ削除する（`descript` モジュール自体は `pub mod` のまま維持。クレート内テストは `descript::parse_descript` 直接参照で動く。参照エラーが出た場合はテスト側の `use` を `crate::descript::parse_descript` に更新する）。

- [ ] **Step 4: テストで回帰確認**

```bash
cargo test --workspace
```

期待: 全パス（削除したテスト分だけ件数が減る）。

- [ ] **Step 5: コミット**

```bash
git add crates/ghost-meta/src/lib.rs crates/ghost-meta/src/ghost.rs
git commit -m "refactor: 本番未使用の ghost_meta::scan_ghosts を削除 (#{N1})

バックエンドは walk_parent からエントリ単位で read_ghost を呼ぶのみで、
一括走査 scan_ghosts はクレート自身のテスト以外に呼び出し元がない（YAGNI）。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 1-3: scan.rs の冗長な name ソート削除

**Files:**
- Modify: `src-tauri/src/commands/ghost/scan.rs:230`（`ghosts.sort_by_cached_key` 削除）
- Modify: `src-tauri/src/commands/ghost/mod.rs:182-230`（テストの順序依存を解消）

**テスト方針:** 表示順は SQL の `ORDER BY` が決める（SPEC §6.1「ソートはフロント担当」）。scan 結果の順序に依存する消費者は存在しないため、削除の Red は書けない。先にテストの契約を順序非依存へ緩和し、Green を維持したまま削除する。

- [ ] **Step 1: テスト `scan_ghosts_internal_collects_sources_and_sorts_by_name` を順序非依存に書き換え**

`mod.rs` の当該テストを以下に置換（テスト名から `_and_sorts_by_name` を外し、`ghosts[0].name == "Alpha"` 等の順序 assert 3 行を names 集合 assert に置換。source の検証 3 ブロックはそのまま）:

```rust
    #[test]
    fn scan_ghosts_internal_collects_sources() -> Result<(), String> {
        // ...（workspace / ssp_dir / extra_a / extra_b のセットアップは既存のまま）...

        let (ghosts, _) =
            scan_ghosts_with_fingerprint_internal(&ssp_root.to_string_lossy(), &additional_paths)?;

        assert_eq!(ghosts.len(), 3);
        let mut names: Vec<&str> = ghosts.iter().map(|g| g.name.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["Alpha", "bravo", "zulu"]);

        // ...（ssp_ghost_item / extra_a / extra_b の source 検証は既存のまま）...
        Ok(())
    }
```

- [ ] **Step 2: テストが通ることを確認（ソート削除前の Green 維持）**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib scan_ghosts_internal_collects_sources
```

- [ ] **Step 3: scan.rs から `ghosts.sort_by_cached_key(|ghost| ghost.name.to_lowercase());` の 1 行を削除**

- [ ] **Step 4: 全テストで回帰確認**

```bash
cargo test --workspace
```

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/commands/ghost/scan.rs src-tauri/src/commands/ghost/mod.rs
git commit -m "refactor: scan 結果の冗長な name ソートを削除 (#{N1})

表示順は SQL の ORDER BY が唯一の権威（SPEC §6.1）。scan 結果は
rusqlite の差分 UPSERT に渡るのみで挿入順に意味がなく、10 万件規模で
毎スキャン無駄な CPU を消費していた。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 1-4: Ghost 構造体の serde 残滓整理

**Files:**
- Modify: `src-tauri/src/commands/ghost/types.rs:5`（derive 削減）+ 同ファイルの JSON キーテスト削除

**テスト方針:** 使われない能力（serde）とそれを守るテストの削除。前提検証 grep が Red の代替。

- [ ] **Step 1: Ghost が serialize される本番経路がないことを確認**

```bash
grep -rn "serde_json::to\|serde_json::from\|to_value\|from_value" --include="*.rs" src-tauri/src/ | grep -v "#\[cfg(test)\]" | grep -v "tests"
```

期待: 本番コードでのヒット 0 件（Ghost は rusqlite にフィールド単位でバインドされ IPC を渡らない）。
**ヒットがあれば中止して報告。**

- [ ] **Step 2: derive を削減し、JSON キーテストを削除**

`types.rs:5` を以下に変更:

```rust
#[derive(Debug, Clone)]
pub struct Ghost {
```

同ファイルの `ghost_の_json_フィールド名が_ts_型と一致する` テストを丸ごと削除（Ghost は IPC を渡らないため JSON キーは実経路で強制されない。DB カラム名との一致は store.rs のテストが実スキーマへの INSERT で担保済み）。`use serde::{Deserialize, Serialize};` は ScanStoreResult が使うため残す。

- [ ] **Step 3: コンパイルとテスト**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

期待: 全パス。ts-rs 生成（ScanStoreResult）に影響なし。

- [ ] **Step 4: コミット**

```bash
git add src-tauri/src/commands/ghost/types.rs
git commit -m "refactor: IPC を渡らない Ghost から serde derive と JSON キーテストを削除 (#{N1})

Ghost は rusqlite 直接書込のみで serialize されない（IPC 転送時代の残滓）。
実経路で強制されないテストは誤った安心感を生むため削除。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 1-5: scan.rs ↔ fingerprint.rs の相互依存解消

**Files:**
- Modify: `src-tauri/src/commands/ghost/path_utils.rs`（`unique_sorted_additional_folders` を受け入れ）
- Modify: `src-tauri/src/commands/ghost/scan.rs:75-90`（同関数を削除、import 変更）
- Modify: `src-tauri/src/commands/ghost/fingerprint.rs:6`（import 変更）
- Modify: `src-tauri/src/commands/ghost/mod.rs:105`（テストの import 変更）

**Interfaces:**
- Produces: `path_utils::unique_sorted_additional_folders(&[String]) -> Vec<(String, PathBuf, String)>`（シグネチャ不変・移動のみ）

**テスト方針:** 移動リファクタリング。既存テスト（`unique_sorted_additional_folders_dedupes_by_normalized_path` ほか）が Green のまま通ることが検証。

- [ ] **Step 1: 関数を path_utils.rs へ移動**

`scan.rs:75-90` の `unique_sorted_additional_folders` を丸ごと `path_utils.rs` に移し、`use std::path::PathBuf;` を path_utils に追加。scan.rs 側は削除。

- [ ] **Step 2: import を更新**

- `scan.rs`: `use super::path_utils::{normalize_path, unique_sorted_additional_folders};`
- `fingerprint.rs:6`: `use super::scan::unique_sorted_additional_folders;` → `use super::path_utils::unique_sorted_additional_folders;`（`#[cfg(test)] build_fingerprint` 内の `use super::scan::walk_parent;` はテスト専用依存として残す）
- `mod.rs` tests: `use super::scan::{scan_ghosts_with_fingerprint_internal, unique_sorted_additional_folders};` → scan からは `scan_ghosts_with_fingerprint_internal` のみ、`use super::path_utils::unique_sorted_additional_folders;` を追加

- [ ] **Step 3: 依存方向の検証とテスト**

```bash
grep -n "use super::scan" src-tauri/src/commands/ghost/fingerprint.rs
cargo test --workspace
```

期待: fingerprint.rs の scan 依存は `#[cfg(test)]` ブロック内の 1 件のみ。テスト全パス。

- [ ] **Step 4: コミット**

```bash
git add src-tauri/src/commands/ghost/
git commit -m "refactor: unique_sorted_additional_folders を path_utils へ移設し相互依存を解消 (#{N1})

scan → fingerprint（トークン生成）と fingerprint → scan（フォルダ正規化）の
相互 import を、共有ヘルパーの下層（path_utils）移設で一方向化。
残る fingerprint → scan 依存は #[cfg(test)] の build_fingerprint のみ。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 1-6: scanInputsFromSettings 単一入口化

**Files:**
- Modify: `src/lib/ghostScanUtils.ts:37-41`
- Modify: `src/lib/ghostCatalogService.ts:3,22-23`
- Test: `src/lib/ghostScanUtils.test.ts`

**Interfaces:**
- Produces: `scanInputsFromSettings(sspPath: string, ghostFolders: string[]): { additionalFolders: string[]; requestKey: string }`
- `requestKeyFromSettings` は同関数への委譲になる（シグネチャ不変）

- [ ] **Step 1: 失敗するテストを書く**

`ghostScanUtils.test.ts` に追加:

```ts
describe("scanInputsFromSettings", () => {
  it("requestKeyFromSettings と同一のキーと、正規化済みフォルダ配列を返す", () => {
    const sspPath = "C:\\SSP";
    const folders = ["C:\\Ghosts\\Extra", "c:/ghosts/extra", "C:/Ghosts/Another"];
    const inputs = scanInputsFromSettings(sspPath, folders);
    expect(inputs.requestKey).toBe(requestKeyFromSettings(sspPath, folders));
    expect(inputs.additionalFolders).toEqual(buildAdditionalFolders(folders));
    expect(inputs.additionalFolders).toHaveLength(2); // 重複排除済み
  });
});
```

import 行に `scanInputsFromSettings` を追加する。

- [ ] **Step 2: Red を確認**

```bash
npx vitest run src/lib/ghostScanUtils.test.ts
```

期待: FAIL（`scanInputsFromSettings` が export されていない import エラー）。

- [ ] **Step 3: 実装**

`ghostScanUtils.ts` の `requestKeyFromSettings` を以下に置換:

```ts
/// スキャン入力（正規化済み追加フォルダ + request_key）を設定値から組み立てる単一の入口。
/// additionalFolders と requestKey を別々に組み立てると不一致事故の温床になる
/// （過去障害: request_key 二重計算でゴースト一覧が空表示）。
export function scanInputsFromSettings(
  sspPath: string,
  ghostFolders: string[],
): { additionalFolders: string[]; requestKey: string } {
  const additionalFolders = buildAdditionalFolders(ghostFolders);
  return { additionalFolders, requestKey: buildRequestKey(sspPath, additionalFolders) };
}

/// 設定値から request_key のみが必要な場合の入口。scanInputsFromSettings へ委譲する。
export function requestKeyFromSettings(sspPath: string, ghostFolders: string[]): string {
  return scanInputsFromSettings(sspPath, ghostFolders).requestKey;
}
```

`ghostCatalogService.ts` の import と 22-23 行を置換:

```ts
import { scanInputsFromSettings } from "./ghostScanUtils";
// ...
  const { additionalFolders, requestKey } = scanInputsFromSettings(sspPath, ghostFolders);
```

- [ ] **Step 4: Green を確認**

```bash
npx vitest run src/lib/ghostScanUtils.test.ts src/lib/ghostCatalogService.test.ts && npx tsc
```

- [ ] **Step 5: コミット**

```bash
git add src/lib/ghostScanUtils.ts src/lib/ghostCatalogService.ts src/lib/ghostScanUtils.test.ts
git commit -m "refactor: スキャン入力の組み立てを scanInputsFromSettings に単一入口化 (#{N1})

書込経路（ghostCatalogService）だけが requestKeyFromSettings を迂回して
buildAdditionalFolders + buildRequestKey をインライン展開していた。
request_key 不一致事故の再発防止として入口を一本化。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 1-7: チェックリストと PR 作成

- [ ] **Step 1: コミット前チェックリストを全実行**

```bash
npm run build && npm test && npm run check:ui-guidelines && npm run test:ui-guidelines-check && cargo test --workspace && git status --short
```

期待: すべて成功、status 出力なし。

- [ ] **Step 2: push（HTTPS 迂回）と PR 作成**

```bash
git -c credential.helper= -c credential.helper='!gh auth git-credential' push https://github.com/finelagusaz/ghost_launcher.git HEAD:refactor/{N1}-code-intent-cleanup
gh pr create --base main --title "refactor: コード衛生 — ゴミファイル・死んだ API・冗長処理・相互依存の解消" --body "（Summary: Task 1-1〜1-6 の要約 / Test plan: Step 1 のチェックリスト結果 / Closes #{N1} / 🤖 Generated with [Claude Code](https://claude.com/claude-code)）"
```

- [ ] **Step 3: CI 通過を確認し squash マージ（`gh pr checks --watch` → `gh pr merge --squash`）、メモリ手順で後始末**

---

# PR-2: random ソート修正 + IPC ラッパー対称化 + テスト補強

**前提:** PR-1 マージ後の main から分岐する。

### Task 2-0: issue 発番とブランチ作成

- [ ] **Step 1: issue 作成 → 番号を `{N2}` とする**

```bash
gh issue create --title "random ソートのページ局所シャッフル修正・IPC ラッパー対称化・中核フックのテスト補強" --body "アーキテクチャ診断のフォローアップ。random ソートを安定シード付き SQL ORDER BY に変更（ユーザー承認済み方針）、launch_ghost/validate_ssp_path の invoke を lib 層ラッパーに集約、launch_ghost 分岐・useVirtualizedList・useGhosts のテスト追加。

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 2: `git switch main && git switch -c fix/{N2}-random-sort-and-ipc-wrapper`**

### Task 2-1: SSP IPC ラッパー `sspClient.ts` の新設（TDD）

**Files:**
- Create: `src/lib/sspClient.ts`
- Test: `src/lib/sspClient.test.ts`

**Interfaces:**
- Produces: `launchGhost(sspPath: string, ghost: Pick<GhostView, "directory_name" | "source" | "ghost_identity_key">): Promise<void>`（起動 + 履歴記録 fire-and-forget）
- Produces: `validateSspPath(sspPath: string): Promise<void>`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/sspClient.test.ts` を新規作成（`@tauri-apps/*` は vitest.config の alias で自動モック済み。IPC モック契約: launch_ghost の引数は camelCase）:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRecordLaunch } = vi.hoisted(() => ({ mockRecordLaunch: vi.fn() }));
vi.mock("./ghostDatabase", () => ({ recordLaunch: mockRecordLaunch }));

beforeEach(() => {
  vi.resetModules();
  mockRecordLaunch.mockReset();
  mockRecordLaunch.mockResolvedValue(undefined);
});

const ghost = { directory_name: "my_ghost", source: "ssp", ghost_identity_key: "sspmy_ghost" };

describe("sspClient", () => {
  it("launchGhost が launch_ghost IPC を camelCase 引数で呼び、履歴を記録する", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const { launchGhost } = await import("./sspClient");
    await launchGhost("C:\\SSP", ghost);
    expect(invoke).toHaveBeenCalledWith("launch_ghost", {
      sspPath: "C:\\SSP",
      ghostDirectoryName: "my_ghost",
      ghostSource: "ssp",
    });
    expect(mockRecordLaunch).toHaveBeenCalledWith("sspmy_ghost");
  });

  it("ghost_identity_key が空なら履歴を記録しない", async () => {
    const { launchGhost } = await import("./sspClient");
    await launchGhost("C:\\SSP", { ...ghost, ghost_identity_key: "" });
    expect(mockRecordLaunch).not.toHaveBeenCalled();
  });

  it("履歴記録の失敗は起動成功を妨げない", async () => {
    mockRecordLaunch.mockRejectedValue(new Error("db down"));
    const { launchGhost } = await import("./sspClient");
    await expect(launchGhost("C:\\SSP", ghost)).resolves.toBeUndefined();
  });

  it("validateSspPath が validate_ssp_path IPC を呼ぶ", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const { validateSspPath } = await import("./sspClient");
    await validateSspPath("C:\\SSP");
    expect(invoke).toHaveBeenCalledWith("validate_ssp_path", { sspPath: "C:\\SSP" });
  });
});
```

- [ ] **Step 2: Red を確認** — `npx vitest run src/lib/sspClient.test.ts` → FAIL（`./sspClient` 不在）

- [ ] **Step 3: 実装**

`src/lib/sspClient.ts` を新規作成:

```ts
import { invoke } from "@tauri-apps/api/core";
import { recordLaunch } from "./ghostDatabase";
import type { GhostView } from "../types";

export type LaunchTarget = Pick<GhostView, "directory_name" | "source" | "ghost_identity_key">;

/// launch_ghost IPC の唯一の入口。起動成功時に起動履歴を fire-and-forget で記録する。
export async function launchGhost(sspPath: string, ghost: LaunchTarget): Promise<void> {
  await invoke("launch_ghost", {
    sspPath,
    ghostDirectoryName: ghost.directory_name,
    ghostSource: ghost.source,
  });
  if (ghost.ghost_identity_key) {
    void recordLaunch(ghost.ghost_identity_key).catch(() => {});
  }
}

/// validate_ssp_path IPC の唯一の入口。
export async function validateSspPath(sspPath: string): Promise<void> {
  await invoke("validate_ssp_path", { sspPath });
}
```

- [ ] **Step 4: Green を確認** — `npx vitest run src/lib/sspClient.test.ts`

- [ ] **Step 5: コミット**

```bash
git add src/lib/sspClient.ts src/lib/sspClient.test.ts
git commit -m "feat: SSP IPC ラッパー sspClient を新設 (#{N2})

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2-2: コンポーネントの生 invoke をラッパーへ移行

**Files:**
- Modify: `src/App.tsx:23-24,126-146`
- Modify: `src/components/GhostCard.tsx:4,17,221-238`
- Modify: `src/components/SettingsPanel.tsx`（invoke import と 112 行）

**Interfaces:**
- Consumes: Task 2-1 の `launchGhost` / `validateSspPath`

**テスト方針:** 既存のコンポーネントテスト（App.test.tsx / GhostCard.test.tsx / SettingsPanel.test.tsx）が invoke モックを検証しており、ラッパー経由でも同じ IPC 呼び出しに到達するため Green のまま通ることが移行の検証になる。テストが invoke を直接 spy している場合も呼び出し内容は不変。

- [ ] **Step 1: App.tsx の移行**

- import: `import { invoke } from "@tauri-apps/api/core";` を削除、`import { getRandomGhost, recordLaunch } from "./lib/ghostDatabase";` → `import { getRandomGhost } from "./lib/ghostDatabase";`、`import { launchGhost } from "./lib/sspClient";` を追加
- `handleRandomLaunch` 内の `await invoke("launch_ghost", {...});` と `if (ghost.ghost_identity_key) { void recordLaunch(...); }` の 2 ブロックを `await launchGhost(sspPath, ghost);` の 1 行に置換

- [ ] **Step 2: GhostCard.tsx の移行**

- import: `convertFileSrc, invoke` → `convertFileSrc` のみ、`recordLaunch` import 削除、`import { launchGhost } from "../lib/sspClient";` 追加
- `handleLaunch` 内の invoke + recordLaunch ブロックを `await launchGhost(sspPath, ghost);` に置換

- [ ] **Step 3: SettingsPanel.tsx の移行**

- `invoke` import を `import { validateSspPath } from "../lib/sspClient";` に置換
- `await invoke("validate_ssp_path", { sspPath: selected });` → `await validateSspPath(selected);`

- [ ] **Step 4: 生 invoke が components/App から消えたことを検証**

```bash
grep -rn "from \"@tauri-apps/api/core\"" src/App.tsx src/components/
npx vitest run && npx tsc
```

期待: grep ヒットは GhostCard.tsx の `convertFileSrc` のみ。テスト全パス。

- [ ] **Step 5: コミット**

```bash
git add src/App.tsx src/components/GhostCard.tsx src/components/SettingsPanel.tsx
git commit -m "refactor: コンポーネントの生 invoke を sspClient ラッパーへ集約 (#{N2})

launch_ghost の呼び出し重複（App.tsx / GhostCard.tsx）を解消し、
IPC 境界の camelCase 引数名を lib 層に閉じ込める。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2-3: launch_ghost の引数構築を純関数化してテスト（TDD）

**Files:**
- Modify: `src-tauri/src/commands/ssp.rs`

**Interfaces:**
- Produces: `fn build_ghost_arg(ghost_source: &str, ghost_directory_name: &str) -> String`（private）

- [ ] **Step 1: 失敗するテストを書く**

`ssp.rs` 末尾に追加:

```rust
#[cfg(test)]
mod tests {
    use super::{build_ghost_arg, validate_ssp_path};

    #[test]
    fn ssp内ゴーストはディレクトリ名のみを渡す() {
        assert_eq!(build_ghost_arg("ssp", "my_ghost"), "my_ghost");
    }

    #[test]
    fn 外部ゴーストはsourceと結合したフルパスを渡す() {
        assert_eq!(
            build_ghost_arg("C:\\Ghosts\\Extra", "my_ghost"),
            "C:\\Ghosts\\Extra\\my_ghost"
        );
    }

    #[test]
    fn validate_ssp_path_はssp_exe不在でエラーを返す() {
        let result = validate_ssp_path("C:\\__ghost_launcher_no_such_dir__".to_string());
        assert!(result.is_err());
    }
}
```

- [ ] **Step 2: Red を確認** — `cargo test --manifest-path src-tauri/Cargo.toml --lib ssp` → コンパイルエラー（`build_ghost_arg` 未定義）

- [ ] **Step 3: 実装（launch_ghost から分岐を抽出）**

```rust
/// SSP へ渡すゴースト指定引数を構築する。
/// SSP 内ゴースト（source == "ssp"）はディレクトリ名のみ、外部ゴーストはフルパス。
fn build_ghost_arg(ghost_source: &str, ghost_directory_name: &str) -> String {
    if ghost_source == "ssp" {
        ghost_directory_name.to_string()
    } else {
        Path::new(ghost_source)
            .join(ghost_directory_name)
            .to_string_lossy()
            .into_owned()
    }
}
```

`launch_ghost` 内の `let ghost_arg = if ... };` ブロックを `let ghost_arg = build_ghost_arg(&ghost_source, &ghost_directory_name);` に置換。

- [ ] **Step 4: Green を確認** — `cargo test --manifest-path src-tauri/Cargo.toml --lib ssp`

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/commands/ssp.rs
git commit -m "test: launch_ghost のゴースト引数分岐を純関数化しテストを追加 (#{N2})

起動の中核分岐（ssp=ディレクトリ名/外部=フルパス）が未テストだった。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2-4: random ソートを安定シード付き SQL ORDER BY へ（TDD）

**Files:**
- Modify: `src/lib/ghostDatabase.ts`（buildOrderBy + シード管理）
- Modify: `src/hooks/useSearch.ts:8-16,62,84`（shuffleArray 削除）
- Modify: `src/App.tsx:148-151`（reseed 呼び出し）
- Test: `src/lib/ghostDatabase.test.ts`

**Interfaces:**
- Produces: `reseedRandomSort(): void`（ghostDatabase.ts から export）

- [ ] **Step 1: 失敗するテストを書く**

`ghostDatabase.test.ts` に追加:

```ts
describe("ghostDatabase - random ソートの安定シード", () => {
  it("searchGhosts が random でシード付き ORDER BY を発行する（JS シャッフルしない）", async () => {
    const { searchGhosts } = await import("./ghostDatabase");
    await searchGhosts("rk", "", 10, 0, "random");
    const sql = mockSelect.mock.calls
      .map((c) => c[0] as string)
      .find((q) => q.includes("ORDER BY"));
    expect(sql).toMatch(/\(g\.id \* \d+\) % 1000003, g\.id/);
  });

  it("同一シード中は searchGhostsInitialPage も同じ ORDER BY 式を使う", async () => {
    const { searchGhosts, searchGhostsInitialPage } = await import("./ghostDatabase");
    await searchGhosts("rk", "", 10, 0, "random");
    await searchGhostsInitialPage("rk", 10, "random");
    const sqls = mockSelect.mock.calls
      .map((c) => c[0] as string)
      .filter((q) => q.includes("% 1000003"));
    const seedOf = (q: string) => q.match(/g\.id \* (\d+)/)?.[1];
    expect(seedOf(sqls[0])).toBe(seedOf(sqls[1]));
  });

  it("reseedRandomSort でシードが変わる", async () => {
    const randomSpy = vi
      .spyOn(Math, "random")
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.9);
    const { searchGhosts, reseedRandomSort } = await import("./ghostDatabase");
    await searchGhosts("rk", "", 10, 0, "random");
    reseedRandomSort();
    await searchGhosts("rk", "", 10, 0, "random");
    const sqls = mockSelect.mock.calls
      .map((c) => c[0] as string)
      .filter((q) => q.includes("% 1000003"));
    expect(sqls[0]).not.toEqual(sqls[1]);
    randomSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Red を確認** — `npx vitest run src/lib/ghostDatabase.test.ts` → FAIL（random は現状 name 順 SQL のため `% 1000003` 不一致 / `reseedRandomSort` 不在）

- [ ] **Step 3: ghostDatabase.ts を実装**

`buildOrderBy` の直前に追加:

```ts
// random ソート用のセッションシード。ORDER BY 式を固定することで、
// 仮想スクロールの offset ページングとバッファマージに対して順序が安定する。
// 素数の剰余で id を攪拌する。剰余の衝突は第 2 キー g.id で安定化する。
const RANDOM_SORT_MODULUS = 1000003;

function newRandomSortSeed(): number {
  return Math.floor(Math.random() * (RANDOM_SORT_MODULUS - 1)) + 1;
}

let randomSortSeed = newRandomSortSeed();

/// random ソートの並びを引き直す（ソートで「ランダム」を選択したときに呼ぶ）
export function reseedRandomSort(): void {
  randomSortSeed = newRandomSortSeed();
}
```

`buildOrderBy` の switch に case を追加:

```ts
    case "random":
      return {
        join: "",
        orderBy: `(g.id * ${randomSortSeed}) % ${RANDOM_SORT_MODULUS}, g.id`,
      };
```

- [ ] **Step 4: useSearch.ts から JS シャッフルを削除**

- `shuffleArray` 関数（8-16 行）を削除
- 62 行 `if (sortOrder === "random") initialGhosts = shuffleArray(initialGhosts);` を削除（`let initialGhosts` → `const initialGhosts`）
- 84 行 `if (sortOrder === "random") result.ghosts = shuffleArray(result.ghosts);` を削除

- [ ] **Step 5: App.tsx の handleSortChange で reseed**

```ts
  const handleSortChange = useCallback((value: SortOrder) => {
    // 「ランダム」を選ぶたびに並びを引き直す（同値再選択は sortOrder が変わらないため次回 fetch から反映）
    if (value === "random") reseedRandomSort();
    setSortOrder(value);
    setOffset(0);
  }, [setOffset]);
```

import に `reseedRandomSort` を追加（`./lib/ghostDatabase` から）。

- [ ] **Step 6: 既存テストの shuffle 参照を確認・更新**

```bash
grep -n "shuffle\|random" src/hooks/useSearch.test.ts
```

shuffleArray の挙動を検証しているテストがあれば削除する（挙動そのものを撤去したため）。「random でも total が正しい」等のソート非依存テストは残す。

- [ ] **Step 7: Green を確認**

```bash
npx vitest run && npx tsc
```

- [ ] **Step 8: コミット**

```bash
git add src/lib/ghostDatabase.ts src/lib/ghostDatabase.test.ts src/hooks/useSearch.ts src/App.tsx
git commit -m "fix: random ソートを安定シード付き SQL ORDER BY に変更 (#{N2})

従来はページ単位の JS 局所シャッフルで、仮想スクロールの offset ページング
と組むとウィンドウ毎に独立シャッフルされ全体順序が破綻していた。
シードをセッション状態に持ち SQL 式を固定することでページ間整合を保証。
「ランダム」再選択で reseed され並びが引き直される。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2-5: useVirtualizedList のテスト新設

**Files:**
- Test: `src/hooks/useVirtualizedList.test.ts`（新規）

**テスト方針:** 既存実装への特性テスト追加。Red は「テストが実装の実際の値と一致するか」の検証で代替する（値が合わなければテストの理解が誤り。実装は変更しない）。

- [ ] **Step 1: テストを書く**

```ts
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useVirtualizedList } from "./useVirtualizedList";

// rowHeight = 90 + 10 = 100, visibleRowCount = ceil(400/100) = 4
const options = { viewportHeight: 400, estimatedRowHeight: 90, overscanRows: 3, gap: 10, totalCount: 1000 };

describe("useVirtualizedList", () => {
  it("初期状態は先頭から可視行 + overscan*2 を返す", () => {
    const { result } = renderHook(() => useVirtualizedList([], options));
    expect(result.current.startIndex).toBe(0);
    expect(result.current.endIndex).toBe(10); // 0 + 4 + 3*2
    expect(result.current.topSpacer).toBe(0);
    expect(result.current.bottomSpacer).toBe((1000 - 10) * 100);
  });

  it("totalCount 未指定なら items.length でスクロール空間を計算する", () => {
    const { result } = renderHook(() =>
      useVirtualizedList(new Array(6).fill(null), { ...options, totalCount: undefined }),
    );
    expect(result.current.endIndex).toBe(6); // itemCount=6 にクランプ
    expect(result.current.bottomSpacer).toBe(0);
  });

  it("totalCount の減少でインデックスとスクロール空間を再計算する", () => {
    const { result, rerender } = renderHook(
      ({ total }: { total: number }) => useVirtualizedList([], { ...options, totalCount: total }),
      { initialProps: { total: 1000 } },
    );
    rerender({ total: 5 });
    expect(result.current.endIndex).toBe(5);
    expect(result.current.bottomSpacer).toBe(0);
  });

  it("itemCount が 0 でも負のインデックスにならない", () => {
    const { result } = renderHook(() => useVirtualizedList([], { ...options, totalCount: 0 }));
    expect(result.current.startIndex).toBe(0);
    expect(result.current.endIndex).toBe(0);
    expect(result.current.bottomSpacer).toBe(0);
  });
});
```

- [ ] **Step 2: 実行して全パスを確認（値が合わない場合は実装を読み直しテスト側を修正。実装は変更しない）**

```bash
npx vitest run src/hooks/useVirtualizedList.test.ts
```

- [ ] **Step 3: コミット**

```bash
git add src/hooks/useVirtualizedList.test.ts
git commit -m "test: useVirtualizedList の index/spacer 計算に特性テストを追加 (#{N2})

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2-6: useGhosts のテスト新設

**Files:**
- Test: `src/hooks/useGhosts.test.ts`（新規）

- [ ] **Step 1: テストを書く**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const { mockRefreshGhostCatalog } = vi.hoisted(() => ({ mockRefreshGhostCatalog: vi.fn() }));
vi.mock("../lib/ghostCatalogService", () => ({ refreshGhostCatalog: mockRefreshGhostCatalog }));

import { useGhosts } from "./useGhosts";

beforeEach(() => {
  mockRefreshGhostCatalog.mockReset();
  mockRefreshGhostCatalog.mockResolvedValue({ skipped: false });
});

describe("useGhosts", () => {
  it("マウント時に refresh が走り loading が収束する", async () => {
    const { result } = renderHook(() => useGhosts("C:/ssp", []));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockRefreshGhostCatalog).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it("同一 inFlightKey の並行 refresh は 1 回に抑止される", async () => {
    let resolveScan: ((v: { skipped: boolean }) => void) | undefined;
    mockRefreshGhostCatalog.mockImplementation(
      () => new Promise((resolve) => { resolveScan = resolve; }),
    );
    const { result } = renderHook(() => useGhosts("C:/ssp", []));
    // マウント時の refresh が in-flight の間に同一キーで再度呼ぶ
    await act(async () => {
      void result.current.refresh();
      void result.current.refresh();
    });
    expect(mockRefreshGhostCatalog).toHaveBeenCalledTimes(1);
    await act(async () => { resolveScan?.({ skipped: false }); });
  });

  it("forceFullScan は別 inFlightKey なので抑止されない", async () => {
    let resolveScan: ((v: { skipped: boolean }) => void) | undefined;
    mockRefreshGhostCatalog.mockImplementation(
      () => new Promise((resolve) => { resolveScan = resolve; }),
    );
    const { result } = renderHook(() => useGhosts("C:/ssp", []));
    await act(async () => {
      void result.current.refresh({ forceFullScan: true });
    });
    expect(mockRefreshGhostCatalog).toHaveBeenCalledTimes(2);
    await act(async () => { resolveScan?.({ skipped: false }); });
  });

  it("スキャン失敗でエラーメッセージが設定される", async () => {
    mockRefreshGhostCatalog.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useGhosts("C:/ssp", []));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toContain("boom");
  });

  it("sspPath が null なら refresh せず loading が収束する", async () => {
    const { result } = renderHook(() => useGhosts(null, []));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockRefreshGhostCatalog).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 実行して全パスを確認（並行抑止テストが 2 回呼び出しになる場合、マウント effect と手動 refresh のタイミング競合を疑い `waitFor` で in-flight 状態を確認してから refresh する形に調整する。実装は変更しない）**

```bash
npx vitest run src/hooks/useGhosts.test.ts
```

- [ ] **Step 3: コミット**

```bash
git add src/hooks/useGhosts.test.ts
git commit -m "test: useGhosts の in-flight 重複排除とエラー処理にテストを追加 (#{N2})

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2-7: チェックリスト・E2E・PR 作成

- [ ] **Step 1: コミット前チェックリスト全実行**（PR-1 Task 1-7 Step 1 と同一コマンド）

- [ ] **Step 2: E2E 手動実行**（UI 操作に関わる変更のため必須）

```bash
npm run tauri build
# 環境変数はメモリ e2e-run-in-this-env を参照（GHOST_LAUNCHER_E2E_APP / EDGEDRIVER_VERSION）
npm run e2e
```

期待: 既知 skip 以外がパス。random ソートと起動ボタンの回帰がないこと。

- [ ] **Step 3: push（HTTPS 迂回）→ `gh pr create`（Closes #{N2}、Test plan に E2E 結果を含める）→ CI 通過 → squash マージ → 後始末**

---

# PR-3: SPEC.md の意図粒度への再構成

**前提:** PR-1・PR-2 マージ後の main から分岐する（SPEC は最終状態を記述するため）。

### Task 3-0: issue 発番とブランチ作成

- [ ] **Step 1: issue 作成 → 番号を `{N3}` とする**

```bash
gh issue create --title "SPEC.md を意図の粒度へ再構成し実装との乖離を解消する" --body "診断で判明した乖離（消滅ファイル名の残存・validate_ssp_path 未記載・ScanStoreResult フィールド不一致・parent_mtimes 欠落・二層フィンガープリント未記載・ソート/起動履歴/ランダム起動の機能群未記載・CI 過小記述）を一括解消。§3 のファイル別責務表はレイヤー責務記述へ再構成する（承認済み方針）。

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 2: `git switch main && git switch -c docs/{N3}-spec-intent-resync`**

**テスト追加なしの理由（PR 説明に明記):** ドキュメントのみの変更。

### Task 3-1: §2 機能一覧と §3 アーキテクチャの再構成

**Files:**
- Modify: `SPEC.md` §2（機能追加）、§3.2・§3.3（表の再構成）

- [ ] **Step 1: §2 の表に 3 行を追加**

```markdown
| F-11 | ソート順切替             | 名前順・最近起動順・起動回数順・ランダム順の切替。起動履歴（ghost_launches）を基盤とする |
| F-12 | ランダム起動             | 一覧から無作為に 1 体選んで起動するボタン                                           |
| F-13 | 起動履歴記録             | ゴースト起動時に ghost_identity_key と起動日時を永続記録                            |
```

- [ ] **Step 2: §3.2 のファイル別責務表を以下へ置換**

方針: モジュール群単位の責務記述にし、関数名の列挙をやめる。個別ファイルの実装事実はコードと `src-tauri/CLAUDE.md` を権威とする。ただし表内に現存しないファイル名を残さないこと（store.rs・db_path.rs を含め、置換後の記述は現状のディレクトリと一致させる）。

```markdown
### 3.2 バックエンド（Rust）構成

**`src-tauri/src/`（Tauri コマンド層）**

| モジュール          | 責務                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `lib.rs`            | Tauri アプリビルダー。コマンド・プラグイン登録・SQLite マイグレーション定義・起動時 DB 検査 |
| `db_path.rs`        | ghosts.db パス解決の単一権威（全経路が app_config_dir 基準を共有）                        |
| `commands/ghost/`   | ゴーストスキャン一式: 走査と型変換（scan）・差分 UPSERT 書込（store）・二層フィンガープリント（fingerprint）・パス正規化（path_utils）・IPC 型定義（types） |
| `commands/ssp.rs`   | SSP 連携: ゴースト起動（launch_ghost）・SSP パス検証（validate_ssp_path）                 |
| `commands/db.rs`    | キャッシュ DB リセット（マイグレーション競合からの自動回復）                              |
| `commands/locale.rs`| ユーザー言語ファイル読込                                                                  |

**`crates/ghost-meta/`（ゴーストメタデータ解析クレート）**

descript.txt のパース（文字コード判定含む）・単体ゴースト読込・サムネイル解決を提供する。
ファイル構成と公開 API はクレートのソースを権威とする。
```

- [ ] **Step 3: §3.3 のファイル別責務表を以下へ置換**

```markdown
### 3.3 フロントエンド（React/TypeScript）構成

| レイヤー      | 責務                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------ |
| `lib/`        | Tauri IPC ラッパー（スキャン・起動・検証）・SQLite 読み書き・キャッシュ判定と寿命管理・設定ストア・i18n 初期化・DB 監視ログ |
| `hooks/`      | React 状態と lib の橋渡し（設定・スキャン・検索・仮想スクロール・テーマ・シェル状態）        |
| `components/` | 表示のみ。IPC を直接呼ばず、lib / hooks 経由でデータを受け取る                              |
| `types/`      | TS 専用型（GhostView・SortOrder 等）と ts-rs 生成型（types/generated/、手書き禁止）         |

依存方向は `components → hooks → lib → IPC` の一方向。ファイル毎の関数名は列挙しない
（実装事実はコードと `src/CLAUDE.md` が権威）。
```

- [ ] **Step 4: §3.1 の図中の `scan.rs` 等のファイル名列挙は残してよいが、`ghostScanClient` / `ghostScanOrchestrator` への言及が図・本文に残っていないか確認**

```bash
grep -n "ghostScanClient\|ghostScanOrchestrator\|scanGhostsWithMeta\|executeScan\|replaceGhostsByRequestKey\|setCachedFingerprint" SPEC.md
```

期待: ヒット 0 件になるまで該当記述を削除・置換（§8 のフロー記述は Task 3-3 で更新する）。

- [ ] **Step 5: コミット**

```bash
git add SPEC.md
git commit -m "docs: SPEC §2-3 を機能追随と意図粒度の構成記述へ再構成 (#{N3})

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3-2: §4 データモデルの訂正

**Files:**
- Modify: `SPEC.md` §4.2・§4.4

- [ ] **Step 1: §4.2 GhostView を DB 投影型として書き直す**

```markdown
### 4.2 GhostView（フロントエンド表示型）

SQLite `ghosts` テーブルからの SELECT 結果を表す型（`diff_fingerprint` 等の内部カラムは含まない）。
選択列は `ghost-view-columns.json` fixture を単一権威として、TS 型・SELECT 文・DB スキーマの
三者が機械照合される（TS コンパイル時検査 + vitest + cargo test）。

`Ghost`（§4.1）のメタデータフィールドに加えて、NFKC 正規化・小文字版の検索用 6 列
（`name_lower` / `sakura_name_lower` / `kero_name_lower` / `craftman_lower` /
`craftmanw_lower` / `directory_name_lower`）と、永続参照キー `ghost_identity_key` を持つ。
```

- [ ] **Step 2: §4.4 ghost_fingerprints 表に parent_mtimes 行を追加**

```markdown
| `parent_mtimes` | `TEXT` | 親ディレクトリ mtime のスナップショット（Layer 1 高速差分判定用、§7.4） |
```

- [ ] **Step 3: コミット**（`docs: SPEC §4 データモデルを実装と同期 (#{N3})`、Co-Authored-By 付き）

### Task 3-3: §6 コマンド仕様と §7/§8 フィンガープリント・キャッシュの同期

**Files:**
- Modify: `SPEC.md` §6・§7・§8

- [ ] **Step 1: §6.1 scan_and_store の戻り値を実装に合わせる**

戻り値行を以下に置換し、ソート行の「ゴーストのソートはフロントエンドが担当」記述は SQL ORDER BY が権威である旨に更新:

```markdown
| 戻り値 | `ScanStoreResult { cache_hit: bool, total: usize, fingerprint: String, request_key: String }`（ts-rs により TS 型を自動生成・CI で照合） |
| ソート | 表示順はフロントエンドの SQL `ORDER BY`（§8）が唯一の権威。scan 結果自体は順序を持たない |
```

- [ ] **Step 2: §6.3〜§6.5 を新設**

```markdown
### 6.3 `validate_ssp_path`

| 項目   | 内容                                                         |
| ------ | ------------------------------------------------------------ |
| 引数   | `ssp_path: String`                                           |
| 戻り値 | `()`                                                         |
| 処理   | `{ssp_path}/ssp.exe` の存在を検証する（設定ダイアログのフォルダ選択時） |
| エラー | `ssp.exe` 不在時にエラーメッセージを返す                     |

### 6.4 `reset_ghost_db`

ghosts.db と WAL/SHM を削除してマイグレーション競合を解消する（§13 の自動回復経路）。
パス解決は書込側と同一の単一権威（`db_path.rs`）を経由する。

### 6.5 `read_user_locale`

実行ファイル横の `locales/{lang}.json` を読み込む（docs/locale-customization.md 参照）。
```

- [ ] **Step 3: §7 に「7.4 二層フィンガープリント」を新設**

```markdown
### 7.4 二層フィンガープリント

`scan_and_store` はフル走査の前に軽量な事前判定を行う。

- **Layer 1（親 mtime 判定, < 1ms）**: 親ディレクトリ（SSP の `ghost/` と各追加フォルダ）の
  mtime スナップショットを `ghost_fingerprints.parent_mtimes` と比較し、一致すれば走査せず
  `cache_hit: true` を返す。NTFS では直下のエントリ追加・削除でのみ親 mtime が変化するため、
  ゴーストの増減はこの層で検出できる。既存ゴースト内の descript.txt 編集は検出できない
  （「再読込」の強制フルスキャンで対応）
- **Layer 2（フル fingerprint）**: §7.1〜7.2 のトークンハッシュ。Layer 1 不一致時に全エントリを
  走査して計算し、`cached_fingerprint` と一致すれば書込をスキップして `parent_mtimes` のみ更新する
```

- [ ] **Step 4: §8.1 のフロー記述から消滅した関数名を排し、ソート仕様を追記**

§8.1 の手順 5「スキャン結果を SQLite へ置換保存（replaceGhostsByRequestKey）し、fingerprint を SQLite へ更新（setCachedFingerprint）」を以下へ置換:

```markdown
5. **キャッシュミス時**: Rust 側が走査結果を rusqlite の差分 UPSERT で直接書き込み、
   fingerprint と parent_mtimes を同トランザクションで更新する（JS は Ghost 配列を受け取らない）
```

§8 末尾に追記:

```markdown
### 8.6 表示ソート

一覧の表示順は SQLite の `ORDER BY` が唯一の権威。名前順（NFKC 小文字）・最近起動順・
起動回数順（いずれも `ghost_launches` と LEFT JOIN）・ランダム順を提供する。
ランダム順はセッション毎のシードで `ORDER BY (id * seed) % 素数` を固定し、仮想スクロールの
ページングとバッファマージに対して順序整合を保つ。「ランダム」再選択でシードを引き直す。
```

- [ ] **Step 5: Task 3-1 Step 4 の grep を再実行しヒット 0 件を確認**

- [ ] **Step 6: コミット**（`docs: SPEC §6-8 をコマンド実装・二層フィンガープリントと同期 (#{N3})`、Co-Authored-By 付き）

### Task 3-4: §11 CI 記述の同期と全体整合の最終確認

**Files:**
- Modify: `SPEC.md` §11.1

- [ ] **Step 1: §11.1 のステップ行を実際の ci-build.yml に合わせて置換**

```markdown
- ステップ: `npm run build` → `npm test` → `check:ui-guidelines` → `test:ui-guidelines-check` → `cargo test --workspace` → ts-rs 生成型の再生成照合（`git diff --exit-code`） → ghost-meta feature テスト
```

置換前に `.github/workflows/ci-build.yml` を読み、実際のステップ名・順序と一致させること。

- [ ] **Step 2: SPEC 全体の残存乖離を最終 grep**

```bash
grep -n "ghostScanClient\|ghostScanOrchestrator\|scanGhostsWithMeta\|executeScan\|replaceGhostsByRequestKey\|setCachedFingerprint\|scan_ghosts" SPEC.md
grep -n "fingerprint: String, cache_hit" SPEC.md
```

期待: すべて 0 件。

- [ ] **Step 3: コミット → チェックリスト（ドキュメントのみだが build/test は実行） → push（HTTPS 迂回） → `gh pr create`（Closes #{N3}、Test plan に「ドキュメントのみのためテスト追加は不適用」と明記） → CI → squash マージ → 後始末**

---

## 完了条件

- [ ] 3 本の PR がすべて main にマージされ、issue {N1}〜{N3} がクローズされている
- [ ] `git status` clean、ローカル・リモートの作業ブランチが削除済み
- [ ] 診断レポートの中重大度以上の項目のうち、非目標表に挙げたもの以外がすべて解消されている
