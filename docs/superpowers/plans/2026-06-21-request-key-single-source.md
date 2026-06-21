# request_key 単一権威化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ゴーストキャッシュの分割キー `request_key` を、Rust/JS の二重導出から**フロントエンド（JS）単一権威**へ集約し、書き込み鍵と読み出し鍵の不一致バグクラスを構造的に根絶する。

**Architecture:** JS が `request_key` を一度だけ計算して `scan_and_store` に値で渡す。Rust は受領値をそのまま使い（不透明トークン）、自前の鍵構築を削除する。読み出し側は新設ヘルパー `requestKeyFromSettings` に集約する。

**Tech Stack:** Tauri 2（Rust / rusqlite）、React 19 / TypeScript、Vitest、tauri-plugin-sql（sqlx）。

## Global Constraints

- 設計書: `docs/superpowers/specs/2026-06-21-request-key-single-source-design.md`（本プランの根拠）。
- ブランチ: 本実装は `fix/request-key-sort-collation`（JS ソート修正済み）を**含む**ベースから行う。現行ブランチ HEAD から作業を継続するか、そこから派生ブランチを切る。ソート修正がないベースで実装すると互換性前提（JS 鍵 = 既存格納鍵）が崩れる。
- IPC 規約: フロントは `invoke()` に camelCase で渡し、Rust は snake_case で受ける（`requestKey` → `request_key`）。戻り値のフィールド名は変換されない（snake_case のまま）。
- IPC 契約型は手書きの `src/lib/dbMonitor.ts` の `ScanStoreResult`（ts-rs 生成型 `src/types/generated/ScanStoreResult.ts` は未使用）。本変更で `ScanStoreResult` の形は変えない（echo）。
- TDD: コード変更は失敗するテストを先に書く。DRY / YAGNI / 頻繁なコミット。
- コミット前チェックリスト（CLAUDE.md）: `npm run build` / `npm test` / `npm run check:ui-guidelines` / `npm run test:ui-guidelines-check` / `cargo test --manifest-path src-tauri/Cargo.toml`。

---

## File Structure

| ファイル | 責務 | 変更種別 |
|---|---|---|
| `src/lib/ghostScanUtils.ts` | パス正規化・request_key 生成。`requestKeyFromSettings` を新設 | 修正 |
| `src/lib/ghostScanUtils.test.ts` | 上記のテスト | 修正 |
| `src/lib/ghostCatalogService.ts` | `scan_and_store` 呼び出し。`requestKey` を送出 | 修正 |
| `src/lib/ghostCatalogService.test.ts` | 上記のテスト | 修正 |
| `src/App.tsx` | 読み出し側 request_key 計算をヘルパーへ | 修正 |
| `src/hooks/useGhosts.ts` | 読み出し側 request_key 計算をヘルパーへ | 修正 |
| `src-tauri/src/commands/ghost/mod.rs` | `scan_and_store` が `request_key` を受領・空キーガード・自前構築削除 | 修正 |
| `SPEC.md` / `src-tauri/CLAUDE.md` / `src-tauri/src/commands/ghost/store.rs` | ドキュメント・コメント同期 | 修正 |

---

## Task 1: `requestKeyFromSettings` ヘルパーを新設し、ソートコメントを更新

**Files:**
- Modify: `src/lib/ghostScanUtils.ts`
- Test: `src/lib/ghostScanUtils.test.ts`

**Interfaces:**
- Produces: `export function requestKeyFromSettings(sspPath: string, ghostFolders: string[]): string` — `ghostFolders`（生の配列）から `buildAdditionalFolders` を必ず経由して `request_key` を返す単一の入口。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/ghostScanUtils.test.ts` の import に `requestKeyFromSettings` を追加し、末尾に追記:

```typescript
describe("requestKeyFromSettings", () => {
  it("buildRequestKey(sspPath, buildAdditionalFolders(folders)) と等価", () => {
    const folders = ["C:\\g\\b", "C:\\g\\a"];
    expect(requestKeyFromSettings("C:\\SSP", folders)).toBe(
      buildRequestKey("C:\\SSP", buildAdditionalFolders(folders)),
    );
  });

  // NFKC を適用しない不変条件: 半角カナ ｱ(U+FF71) を全角 ア(U+30A2) へ畳まない。
  // 畳むと別フォルダを同一視してしまう。
  it("NFKC を適用せず半角カナをそのまま保持する", () => {
    expect(requestKeyFromSettings("C:\\SSP", ["C:\\g\\ｱ"])).toBe("c:/ssp::c:/g/ｱ");
  });
});
```

import 行を更新:

```typescript
import { normalizePathKey, buildAdditionalFolders, buildRequestKey, requestKeyFromSettings } from "./ghostScanUtils";
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/lib/ghostScanUtils.test.ts`
Expected: FAIL（`requestKeyFromSettings is not a function` / import エラー）

- [ ] **Step 3: ヘルパーを実装**

`src/lib/ghostScanUtils.ts` の `buildRequestKey` 関数の直後に追加:

```typescript
/// 設定値（sspPath + 生のフォルダ配列）から request_key を組み立てる単一の入口。
/// buildAdditionalFolders を必ず経由させ、呼び出し側での付け忘れを防ぐ。
export function requestKeyFromSettings(sspPath: string, ghostFolders: string[]): string {
  return buildRequestKey(sspPath, buildAdditionalFolders(ghostFolders));
}
```

- [ ] **Step 4: ソートコメントを更新（コメント負債の解消）**

`src/lib/ghostScanUtils.ts` の `buildAdditionalFolders` 内のコメントを置換:

```typescript
  // ソート順は JS 内部で決定的であればよい（Lv1 で request_key は JS 単一権威）。
  // localeCompare はロケール依存で '_'(0x5F) を '2'(0x32) より前に並べ、環境差を
  // 生むため使わない。コードポイント順（UTF-16 コードユニット順）で比較する。
```

`src/lib/ghostScanUtils.test.ts` の「コードポイント順でソートする」テスト上のコメントを置換:

```typescript
  // request_key は JS 単一権威（Lv1）。ソートはロケール非依存の決定性が要件。
  // localeCompare では '_'(0x5F) が '2'(0x32) より前に来て環境差を生むため使わない。
  // コードポイント順では '2' < '_' なので ghost2 が先でなければならない。
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/lib/ghostScanUtils.test.ts`
Expected: PASS（全ケース green）

- [ ] **Step 6: コミット**

```bash
git add src/lib/ghostScanUtils.ts src/lib/ghostScanUtils.test.ts
git commit -m "feat: request_key 生成の単一入口 requestKeyFromSettings を追加"
```

---

## Task 2: `ghostCatalogService` が `requestKey` を送出する

**Files:**
- Modify: `src/lib/ghostCatalogService.ts`
- Test: `src/lib/ghostCatalogService.test.ts`

**Interfaces:**
- Consumes: `requestKeyFromSettings`（Task 1）。
- Note: この時点で Rust は `requestKey` 引数を宣言していないが、Tauri/serde は未宣言フィールドを無視するため、送出しても実害はない（Rust は引き続き自前の同一鍵を計算する）。本タスク単体で出荷可能。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/ghostCatalogService.test.ts` の import に `requestKeyFromSettings` を追加:

```typescript
import { requestKeyFromSettings } from "./ghostScanUtils";
```

`forceFullScan` の完全一致アサーション（現 line 83-88）を更新:

```typescript
    expect(invoke).toHaveBeenCalledWith("scan_and_store", {
      sspPath: "C:/SSP",
      additionalFolders: [],
      requestKey: "c:/ssp::",
      cachedFingerprint: null,
    });
```

新規テストを `describe("refreshGhostCatalog", ...)` 内に追加:

```typescript
  it("requestKey に requestKeyFromSettings の出力を渡す", async () => {
    vi.mocked(invoke).mockResolvedValue({ cache_hit: false, total: 0, fingerprint: "fp", request_key: "x" });

    await refreshGhostCatalog({
      sspPath: "C:/SSP",
      ghostFolders: ["C:/Ghosts"],
      forceFullScan: true,
    });

    expect(invoke).toHaveBeenCalledWith("scan_and_store", expect.objectContaining({
      requestKey: requestKeyFromSettings("C:/SSP", ["C:/Ghosts"]),
    }));
  });
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/lib/ghostCatalogService.test.ts`
Expected: FAIL（invoke 呼び出しに `requestKey` が含まれない）

- [ ] **Step 3: 実装**

`src/lib/ghostCatalogService.ts` の invoke 呼び出し（line 36-40）を更新。`requestKey` は既に line 23 で算出済み:

```typescript
  const result = await invoke<ScanStoreResult>("scan_and_store", {
    sspPath,
    additionalFolders,
    requestKey,
    cachedFingerprint,
  });
```

cleanup の引数を echo された戻り値ではなくローカル変数に変更（line 53）:

```typescript
  void cleanupOldGhostCaches(requestKey).catch((error) => {
    console.warn("[ghostCatalogService] キャッシュ寿命管理のクリーンアップに失敗しました", error);
  });
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/ghostCatalogService.test.ts`
Expected: PASS（既存の cleanup テストも `requestKey` ローカル値 = `"c:/ssp::"` で一致）

- [ ] **Step 5: コミット**

```bash
git add src/lib/ghostCatalogService.ts src/lib/ghostCatalogService.test.ts
git commit -m "feat: scan_and_store に requestKey を送出し cleanup をローカル鍵に統一"
```

---

## Task 3: 読み出し側（App.tsx / useGhosts）をヘルパーへ集約

**Files:**
- Modify: `src/App.tsx`、`src/hooks/useGhosts.ts`

**Interfaces:**
- Consumes: `requestKeyFromSettings`（Task 1）。
- Note: 振る舞いは不変（`buildRequestKey(sspPath, buildAdditionalFolders(x))` と等価）。純粋なリファクタ。`ghostCatalogService.ts` は invoke で `additionalFolders` を独立に必要とするため、ここでは置換せず明示的な 2 行形式を維持する（重複ではない）。

- [ ] **Step 1: App.tsx を更新**

`src/App.tsx` の import から `buildRequestKey`, `buildAdditionalFolders` を削除し `requestKeyFromSettings` を追加（他で未使用であることを確認）。`searchRequestKey`（line 102-104）を置換:

```typescript
  const searchRequestKey = sspPath
    ? requestKeyFromSettings(sspPath, ghostFolders)
    : null;
```

- [ ] **Step 2: useGhosts.ts を更新**

`src/hooks/useGhosts.ts` の import（line 3）を更新:

```typescript
import { requestKeyFromSettings, buildScanErrorMessage } from "../lib/ghostScanUtils";
```

`refresh` 内（line 26-27）を置換:

```typescript
    const requestKey = requestKeyFromSettings(sspPath, ghostFoldersRef.current);
```

- [ ] **Step 3: 既存テストが通ることを確認（振る舞い不変）**

Run: `npx vitest run`
Expected: PASS（114 件以上、回帰なし）。型エラーがないことも確認: `npm run build`

- [ ] **Step 4: コミット**

```bash
git add src/App.tsx src/hooks/useGhosts.ts
git commit -m "refactor: 読み出し側の request_key 計算を requestKeyFromSettings へ集約"
```

---

## Task 4: Rust `scan_and_store` が `request_key` を受領・空キーガード・自前構築削除

**Files:**
- Modify: `src-tauri/src/commands/ghost/mod.rs`

**Interfaces:**
- Consumes: JS が送る `requestKey`（Task 2）→ Rust `request_key: String`。
- Produces: `scan_and_store(app, ssp_path, additional_folders, request_key, cached_fingerprint)`。戻り値 `ScanStoreResult` は不変（`request_key` を echo）。
- Note: コマンドは `AppHandle` を取るため単体テスト不可。新規ロジックは純関数 `ensure_request_key` のみ TDD する。コマンド配線は `cargo build` + 既存テスト + Task 6 の実機確認で検証する。

- [ ] **Step 1: 空キーガードの失敗するテストを書く**

`src-tauri/src/commands/ghost/mod.rs` の `#[cfg(test)] mod tests` 内に追加:

```rust
    #[test]
    fn ensure_request_key_は空文字を拒否し非空を許可する() {
        assert!(super::ensure_request_key("").is_err());
        assert!(super::ensure_request_key("c:/ssp::").is_ok());
    }
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml ensure_request_key`
Expected: FAIL（`ensure_request_key` 未定義でコンパイルエラー）

- [ ] **Step 3: ガード関数を実装**

`src-tauri/src/commands/ghost/mod.rs` の `scan_and_store` 関数の直前に追加:

```rust
/// request_key が空なら Err を返す。JS 単一権威の信頼境界での最小防御。
/// 空キーで書き込むと全ゴーストが request_key='' パーティションに同居する事故を防ぐ。
fn ensure_request_key(request_key: &str) -> Result<(), String> {
    if request_key.is_empty() {
        return Err("request_key が空です".to_string());
    }
    Ok(())
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml ensure_request_key`
Expected: PASS

- [ ] **Step 5: コマンド署名と本体を更新**

`scan_and_store` の引数に `request_key: String` を追加（`additional_folders` の後、`cached_fingerprint` の前）:

```rust
pub fn scan_and_store(
    app: tauri::AppHandle,
    ssp_path: String,
    additional_folders: Vec<String>,
    request_key: String,
    cached_fingerprint: Option<String>,
) -> Result<ScanStoreResult, String> {
    use tauri::Manager;

    ensure_request_key(&request_key)?;
```

`mod.rs:26-31` の鍵構築ブロック（コメント「request_key の構築（JS 側の buildRequestKey と同一ロジック）」から `let request_key = format!(...)` まで）を**削除**する。`use path_utils::normalize_path;` も鍵用途でのみ使っていたなら削除（`scan.rs` 側の利用は別モジュールなので影響なし。`mod.rs` 内の他利用がないことを確認して削除）。

以降の `request_key` 参照（Layer 1 / Layer 2 / cache miss の各 return、`check_parent_mtimes_match`、`UPDATE`、`store_ghosts`）は引数の `request_key` をそのまま使う。各 return での move はパスが排他的なため問題ない（借用してから move する順序が保たれていることを確認。borrow-checker が要求すれば `.clone()` を補う）。

- [ ] **Step 6: ビルドと全テストが通ることを確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS（既存 36 件 + 新規ガード 1 件。`normalize_path` 削除後の未使用警告がないこと）

- [ ] **Step 7: コミット**

```bash
git add src-tauri/src/commands/ghost/mod.rs
git commit -m "feat: scan_and_store が request_key を受領し自前構築を削除（空キーガード付き）"
```

---

## Task 5: ドキュメント・コメント同期

**Files:**
- Modify: `SPEC.md`、`src-tauri/CLAUDE.md`、`src-tauri/src/commands/ghost/store.rs`

**Interfaces:**
- Note: ドキュメント・コメントのみ。テストは追加しない（CLAUDE.md: ドキュメント更新はテスト不要）。

- [ ] **Step 1: SPEC.md を更新**

§7.3「追加フォルダの正規化」（line 302 付近）に、生成主体と照合順序を明記する。「重複排除後、正規化パスの辞書順でソート」の記述へ次を補う:

> `request_key` はフロントエンド（`ghostScanUtils.ts` の `requestKeyFromSettings`）が唯一計算し、`scan_and_store` に値として渡す。Rust は受領値をそのまま使う（不透明トークン）。ソートはロケール非依存のコードポイント順（`localeCompare` ではない）。

§6.1 / §8.1.3 のコマンド名 `scan_ghosts_with_meta` は実装の `scan_and_store` に合わせて訂正し、引数に `requestKey` が加わる旨を反映する。`request_key` 列の説明（line 166）に「フロントが生成」を補う。

- [ ] **Step 2: src-tauri/CLAUDE.md を更新**

`request_key` に言及する箇所に、「`request_key` はフロントエンドが単一権威として計算し、`scan_and_store` は値で受け取る。Rust 側で再計算しない」旨を追記する。

- [ ] **Step 3: store.rs の虚偽コメントを修正**

`src-tauri/src/commands/ghost/store.rs:15` のコメントを置換（JS に `buildGhostIdentityKey` は存在しない。`normalizeForKey` は実在するため line 10 のコメントは維持）:

```rust
/// ghost_identity_key を構築する（Rust のみで計算し DB 列に書く。JS は列値を読むだけで再計算しない）
```

- [ ] **Step 4: ドキュメントの整合を確認**

Run: `npm run build`（型・ビルドに影響しないことの確認）
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add SPEC.md src-tauri/CLAUDE.md src-tauri/src/commands/ghost/store.rs
git commit -m "docs: request_key 単一権威化に合わせて SPEC・コメントを同期"
```

---

## Task 6: 統合検証（コミット前チェックリスト + 実機確認）

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

- [ ] **Step 2: 実機確認（既存キャッシュが再スキャンなしで表示される）**

`npm run tauri dev` を起動し、設定済みの SSP/フォルダでゴースト一覧が表示されることを確認する。既存 DB の格納鍵と JS 鍵が一致しているため、再スキャンを待たず即時表示されるはず（stale-while-revalidate）。コンソールで `searchGhostsInitialPage(... ) → rows=N`（N>0）を確認。

- [ ] **Step 3: `git status` が clean であることを確認**

```bash
git status
```
Expected: nothing to commit, working tree clean。

---

## Self-Review（作成者チェック済み）

- **Spec coverage**: 設計書の各節 — 改変（Rust/JS）→ Task 2/3/4、空キーガード → Task 4、読出集約 → Task 1/3、互換性（自己修復）→ Task 6 実機確認、テスト → 各 Task の TDD、ドキュメント同期（SPEC §4.5/§7.3/§8.1・CLAUDE.md・コメント負債）→ Task 5。すべて対応タスクあり。
- **Placeholder scan**: 各コード手順に実コードを記載。SPEC.md の長文は新規挿入文を明示し、実装者が該当節を読んで置換する形（doc タスクの性質上許容）。
- **Type consistency**: `requestKeyFromSettings(sspPath, ghostFolders)` の名と引数は Task 1/2/3 で一貫。Rust `request_key: String`・`ensure_request_key(&str) -> Result<(), String>` は Task 4 内で一貫。`ScanStoreResult` は echo で不変。
