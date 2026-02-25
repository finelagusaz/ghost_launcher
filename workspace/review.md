# Ghost Launcher コードレビュー

レビュー日: 2026-02-25
対象: SPEC.md §15 改善タスク実装（PR-1〜PR-6）

---

## 総評

致命的な問題はなし。全体的に正確な実装だが、CI設定の漏れ・UIバグ・テストカバレッジ不足の3点を優先して対応すること。

---

## 致命的な問題

なし。

---

## 高優先度

### [高-1] `SettingsPanel.tsx`: バリデーションエラーがキャンセル後に残る

**ファイル:** `src/components/SettingsPanel.tsx`

ユーザーがバリデーションエラーを出した後、ダイアログを「キャンセル」すると `!selected` で早期 return するためエラーが消えない。次にダイアログを開いたとき古いエラーメッセージが表示されたままになる。

```typescript
// 現在
if (!selected) return; // ← ここで return するとエラーが残り続ける

// 修正案: ダイアログキャンセル時にエラーをクリアする
if (!selected) {
    setValidationError(null);
    return;
}
```

---

### [高-2] `scan.rs` / `fingerprint.rs`: `missing`/`not-directory` トークン生成ロジックが重複

**ファイル:** `src-tauri/src/commands/ghost/scan.rs`（150-163行）、`src-tauri/src/commands/ghost/fingerprint.rs`（74-99行）

追加フォルダが「存在しない」または「ディレクトリでない」場合のトークン生成が両ファイルに重複実装されている。将来どちらかを変更した際にフォーマットのズレが生じると、キャッシュが常に無効化されるバグになる。このケースは `integrated_fingerprint_matches_standalone_build_fingerprint` テストでカバーされていない。

---

### [高-3] `ghostCacheRepository.test.ts`: `pruneOldEntries` および `writeGhostCacheEntry` がテストされていない

**ファイル:** `src/lib/ghostCacheRepository.test.ts`

テストは `isGhostCacheStoreV1` の型ガードのみ。以下の重要な振る舞いがテストされていない:

- `pruneOldEntries`（エントリが10件超で古いものが削除されるか）
- `writeGhostCacheEntry` のキューイング（並行書き込み時の順序保証）
- `readGhostCacheEntry` のキャッシュミス時（`undefined` が返るか）
- キャッシュストアの形式が不正なときのフォールバック

---

## 中優先度

### [中-1] `tauri.conf.json`: `script-src 'unsafe-inline'` の必要性を要確認

**ファイル:** `src-tauri/tauri.conf.json`

`script-src 'unsafe-inline'` は XSS 防御を実質的に無効化する。Tauri 2 が本当にインライン
スクリプトを注入するかどうか、`npm run tauri dev` の開発者ツール Console で CSP エラーが
出ないことを確認した上で、不要であれば削除することを推奨する。

`style-src 'unsafe-inline'` は Fluent UI v9（Griffel）の動的 style 注入に必須。

---

### [中-2] `fingerprint.rs`: `push_entry_token` の戻り値が SRP 的に混在

**ファイル:** `src-tauri/src/commands/ghost/fingerprint.rs`（37-53行）

フィンガープリントトークンの生成（push）とスキャン用の状態判定（`descript_state` の返却）を1つの関数が担っている。コメントで意図は説明されており、KISS/DRY の観点からは合理的なトレードオフ。ただし `scan.rs` が `fingerprint.rs` の内部ロジックに依存する構造になっている点は注意。

現時点では許容範囲。将来 fingerprint とスキャンの分離が必要になったら再検討すること。

---

### [中-3] `ci-build.yml`: `cargo test` が実行されていない（`cargo check` のみ）

**ファイル:** `.github/workflows/ci-build.yml`（47行）

```yaml
# 現在
- name: Check Rust crate
  run: cargo check --manifest-path src-tauri/Cargo.toml

# 修正案
- name: Test Rust crate
  run: cargo test --manifest-path src-tauri/Cargo.toml
```

`integrated_fingerprint_matches_standalone_build_fingerprint` など充実した Rust テスト群が
CI で検証されていない。`cargo test` への変更が必要。

---

### [中-4] `ghostScanUtils.test.ts`: `buildRequestKey` のエッジケースが未テスト

**ファイル:** `src/lib/ghostScanUtils.test.ts`

`buildRequestKey` のセパレータ（`::` / `|`）がパス文字列内に含まれるようなエッジケースが
テストされていない。Windowsパスに `|` は使えないため実害は低いが、念のため確認を推奨。

---

## 低優先度（改善提案）

### [低-1] `fingerprint.rs`: `compute_fingerprint_hash` が呼び出し元の `tokens` を破壊的にソート

**ファイル:** `src-tauri/src/commands/ghost/fingerprint.rs`（56-64行）

`tokens.sort()` により呼び出し元の Vec の順序が変わる副作用がある。現在は呼び出し後に
`tokens` を使用していないため実害なし。将来の変更で問題が発生する可能性あり。
`&[String]` を受け取って内部でソート済みコピーを作成する設計の方が副作用が明確。

---

### [低-2] `SettingsPanel.tsx`: バリデーション中に「追加ゴーストフォルダ」ボタンが有効

**ファイル:** `src/components/SettingsPanel.tsx`（155行）

SSP パスのバリデーション中（`validating=true`）に「追加」ボタンが `disabled` になっていない。
意図的な設計かもしれないが、UI の一貫性として `disabled={validating}` の追加を検討。

---

### [低-3] `ghostCacheRepository.ts`: `isGhostCacheStoreV1` が配列を除外していない

**ファイル:** `src/lib/ghostCacheRepository.ts`（9-20行）

`typeof [] === "object"` は `true` なので `entries: []` のような値が型ガードをパスする。
`!Array.isArray(candidate.entries)` の追加を推奨。

```typescript
return (
  candidate.version === GHOST_CACHE_VERSION &&
  !!candidate.entries &&
  typeof candidate.entries === "object" &&
  !Array.isArray(candidate.entries) // 追加
);
```

---

### [低-4] `vitest.config.ts`: `.test.tsx` がテスト対象外

**ファイル:** `vitest.config.ts`（23行）

```typescript
// 現在
include: ["src/**/*.test.ts"],

// 修正案（React コンポーネントテストに対応）
include: ["src/**/*.test.{ts,tsx}"],
```

---

### [低-5] `ssp.rs`: `ssp.exe` チェックロジックが `validate_ssp_path` と `launch_ghost` で重複

**ファイル:** `src-tauri/src/commands/ssp.rs`

同一ロジックが2か所に存在。CLAUDE.md の「2回まで許容、3回目で抽出」のちょうど境界線。
3か所目が増えたタイミングでプライベートヘルパー関数への抽出を検討すること。

```rust
// 抽出候補
fn resolve_ssp_exe(ssp_path: &str) -> Result<std::path::PathBuf, String> {
    let ssp_exe = std::path::Path::new(ssp_path).join("ssp.exe");
    if !ssp_exe.exists() {
        return Err(format!("ssp.exe が見つかりません: {}", ssp_exe.display()));
    }
    Ok(ssp_exe)
}
```

---

## 評価された良い点

| 項目 | 理由 |
|------|------|
| SHA-256 移行 | `DefaultHasher` はバージョン間非安定のため、永続化フィンガープリントに使うのは不適切だった。根本的に正しい判断 |
| `hasher.update(b"\n")` | トークン境界混同防止。`"a" + "bc"` と `"ab" + "c"` が同じハッシュにならないための適切な実装 |
| vitest alias によるモック | Tauri API モックをエイリアスで透過的に差し替える設計。テストコードへの侵食がなく清潔 |
| `cacheWriteQueue` による直列化 | Promise チェーンによる書き込み直列化は `settingsStore` への並行書き込みを防ぐ正しいアプローチ |
| `integrated_fingerprint_matches_standalone_build_fingerprint` | `build_fingerprint` と `scan_ghosts_with_fingerprint_internal` が同一ハッシュを返すことを保証する最重要テスト |
| TempDirGuard によるRustテスト | `Drop` による自動クリーンアップと実ファイルシステムを使った統合テストで重要なバグを捕捉できる |

---

## 対応優先順位

1. **中-3**: CI に `cargo test` を追加（既存テストが CI で検証されていない）
2. **高-1**: ダイアログキャンセル時のバリデーションエラークリア
3. **高-3**: `pruneOldEntries` / `writeGhostCacheEntry` のテスト追加
4. **中-1**: `script-src 'unsafe-inline'` の実機確認と不要であれば削除
5. **低-3**: `isGhostCacheStoreV1` の配列除外
6. **低-4**: `include` に `.tsx` を追加
7. **高-2**: missing/not-directory トークン生成の重複解消（難度高）
