# Ghost Launcher 改善タスク — 波及的影響調査レポート

作成日: 2026-02-25
対象コミット: main ブランチ（fec9f52 以降）

---

## 調査サマリー

SPEC.md §15 に列挙された 7 件の改善タスクを全コードと照合した結果、
**単独で実施すると不整合・破壊が生じるタスク間の依存関係**、
**SPEC 記述と実装間の矛盾**、
**実装方針が未定義で設計決定が必要な箇所**が複数確認された。

---

## タスク別 詳細調査

---

### T-1: `publish = false` に修正（C-08・優先度：高）

**変更箇所**: `src-tauri/Cargo.toml` line 7

```toml
publish = true  →  publish = false
```

**波及的影響**: なし
純粋なメタデータ変更。実行時挙動・依存関係・型・テストに一切影響しない。

**考慮もれ**:
- `crate-type = ["staticlib", "cdylib", "rlib"]` は Tauri アプリの慣習的な設定。
  `publish = false` にしても `crate-type` を変更する必要はない。

---

### T-2: 安定ハッシュへの移行（C-04・優先度：高）

**変更箇所**: `src-tauri/src/commands/ghost/fingerprint.rs:35-42`

```rust
// 現在
let mut hasher = DefaultHasher::new();
for token in tokens.iter() { token.hash(&mut hasher); }
format!("{:016x}", hasher.finish())
```

#### 波及的影響 ①：ハッシュ出力長の変化

`DefaultHasher::finish()` は u64 → 16 桁 hex。
SHA-256 は 32 bytes → 64 桁 hex。

**SPEC §7.2 との矛盾**:
> "16桁16進数文字列として出力"

SHA-256 を採用した場合、SPEC §7.2 の記述が誤りとなる。
→ SPEC 自体の改訂が必要（または truncation の是非を決定する必要がある）。

#### 波及的影響 ②：既存キャッシュの全無効化

`settings.json` 内の `ghost_cache_v1.entries[*].fingerprint` は全て旧ハッシュ値。
移行後の初回起動時、`validateCache` の比較が全エントリで不一致となり **全ユーザーがフルスキャンに落ちる**。

これは機能的に許容できるが、`GhostCacheStoreV1.version` が `1` のままであるため、
自動マイグレーションの仕組みが存在しない。

**設計決定が必要**:
(a) バージョンを `2` に上げて旧キャッシュを丸ごと破棄するか、
(b) バージョンはそのまま（初回フルスキャンのみ許容）にするか。

(b) を選ぶ場合: コード変更は `compute_fingerprint_hash` のみ。
(a) を選ぶ場合: `GhostCacheStoreV1` → `GhostCacheStoreV2` の型定義・判定関数・
フロントエンド読み込み処理(`useSettings.ts`, `ghostCacheRepository.ts`, `types/index.ts`)の全変更が波及する。

#### 波及的影響 ③：T-3（C-10）との実施順序依存

`compute_fingerprint_hash` は `fingerprint.rs` に定義され、
`scan.rs` からも `use super::fingerprint::compute_fingerprint_hash` でインポートされている。

T-2 と T-3 を別々に実施すると:
- T-2 先行: `compute_fingerprint_hash` を SHA-256 に変更 → T-3 でロジック統合しても同関数を使うので整合
- T-3 先行: ロジック統合中に `compute_fingerprint_hash` を触ると、T-2 が未着手のまま DefaultHasher が残る

**推奨**: T-2 → T-3 の順で実施、または同一 PR で実施する。

#### 波及的影響 ④：依存クレート追加が必要

`Cargo.toml` に SHA-256 用クレートが存在しない。
`sha2 = "0.10"` の追加が必要（`digest` トレイトと共に使用）。

現在の依存:
```toml
encoding_rs = "0.8"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tauri = { version = "2" }
```

`sha2` を追加することで間接依存の `digest`, `block-buffer`, `cpufeatures` 等が加わる。
ビルドサイズへの影響は軽微だが、`cargo check` で確認すること。

#### 波及的影響 ⑤：テストへの影響

`mod.rs` の `integrated_fingerprint_matches_standalone_build_fingerprint` テストは
`build_fingerprint` と `scan_ghosts_with_fingerprint_internal` が同一ハッシュを返すことを検証している。
両者が同じ `compute_fingerprint_hash` を呼ぶ構造は変わらないため、テスト自体は引き続き機能する。

---

### T-3: フィンガープリントロジック統合（C-10・優先度：高）

**変更箇所**:
- `src-tauri/src/commands/ghost/fingerprint.rs`: `push_parent_fingerprint_tokens` の内部ループ
- `src-tauri/src/commands/ghost/scan.rs`: `scan_ghost_dir_with_fingerprint` の内部ループ

#### 重複の現況整理

既に共通化されているもの:
- `metadata_modified_string` (fingerprint.rs で定義、scan.rs がインポート)
- `descript_metadata_for_token` (fingerprint.rs で定義、scan.rs がインポート)
- `compute_fingerprint_hash` (fingerprint.rs で定義、scan.rs がインポート)
- `unique_sorted_additional_folders` (scan.rs で定義、fingerprint.rs がインポート)

**残存している重複**:
`push_parent_fingerprint_tokens`（fingerprint.rs）と
`scan_ghost_dir_with_fingerprint`（scan.rs）の
エントリ走査ループ部分（`for entry in entries`）と
トークン文字列フォーマット（`entry|...|...|...|...|...|...`）。

#### 波及的影響 ①：`build_fingerprint` の存在理由を保持すること

`get_ghosts_fingerprint` Tauri コマンドは **`descript.txt` を読まない**軽量操作として設計されている。
（キャッシュ検証パスのみ呼ばれ、Ghost データは不要）

統合の誤った方針:
`get_ghosts_fingerprint` が `scan_ghosts_with_fingerprint_internal` を呼んで
ghosts 部分を捨てる → `descript.txt` を不要に読み込むことになり機能劣化。

**正しい統合方針**:
エントリ走査 + トークン生成の共通関数 `collect_ghost_dir_tokens` を抽出し、
`push_parent_fingerprint_tokens` と `scan_ghost_dir_with_fingerprint` の両者から呼ぶ。
Ghost の構築は `scan_ghost_dir_with_fingerprint` でのみ行う。

```
push_parent_fingerprint_tokens (fingerprint.rs)
    └─ calls collect_ghost_dir_tokens()
scan_ghost_dir_with_fingerprint (scan.rs)
    └─ calls collect_ghost_dir_tokens() + descript 解析
```

#### 波及的影響 ②：整合性テストが要保護

`integrated_fingerprint_matches_standalone_build_fingerprint` テストは
`build_fingerprint` と `scan_ghosts_with_fingerprint_internal` が同一値を返すことを検証する。
リファクタリング後もこのテストが通ることを必須とする。

#### 波及的影響 ③：scan.rs の `parent|...|missing`, `parent|...|not-directory` トークン

`scan_ghosts_with_fingerprint_internal` では存在チェックを関数外部で行い、
ループに入る前にトークンを直接 push している:

```rust
// scan.rs line 161-174
if !folder_path.exists() {
    tokens.push(format!("parent|{}|{}|missing", normalized_folder, normalized_folder));
    continue;
}
if !folder_path.is_dir() {
    tokens.push(format!("parent|{}|{}|not-directory", normalized_folder, normalized_folder));
    continue;
}
```

一方 `fingerprint.rs::push_parent_fingerprint_tokens` では関数内部でこれらを処理している。

統合する際、この存在チェックを共通関数に含めるか・呼び出し元に残すかを統一する必要がある。
どちらでもトークン文字列が一致していれば問題ないが、**混在させると不整合の温床**になる。

---

### T-4: SSP パス保存時バリデーション（C-06・優先度：中）

**変更箇所（想定）**:
- `src/components/SettingsPanel.tsx`: `handleSelectFolder` 内でバリデーション
- `src-tauri/src/commands/` または新ファイル: `validate_ssp_path` コマンド追加（予定）
- `src-tauri/src/lib.rs`: 新コマンドの登録

#### 波及的影響 ①：新規 Tauri コマンドが必要

現在のフロントエンドから直接ファイル存在を確認する API がない。
`Cargo.toml` に `tauri-plugin-fs` は含まれていない。

選択肢:
- (a) 新しい Rust コマンド `validate_ssp_path(ssp_path: String) -> Result<(), String>` を追加
- (b) `tauri-plugin-fs` を追加してフロントエンドから直接確認

(a) が既存パターン（コマンド主導）に合致する。
(b) は依存追加 + `tauri.conf.json` のパーミッション設定が追加で必要になる。

新コマンドを追加する場合、`lib.rs` の `generate_handler!` へ登録が必要。

#### 波及的影響 ②：SettingsPanel.tsx への状態追加

現在 `SettingsPanel.tsx` にはバリデーションエラーを表示する UI 状態がない。
エラー表示のための `useState<string | null>` 追加と UI 変更が必要。

**現在のフロー**:
```
open() → selected → onPathChange(selected)
```

**変更後のフロー**:
```
open() → selected → validate_ssp_path(selected)
    → OK: onPathChange(selected)
    → NG: setValidationError("ssp.exe が見つかりません")
```

この変更は `SettingsPanel` の Props インターフェースは変えずに実装可能。

#### 波及的影響 ③：`App.tsx` の自動ダイアログ開閉ロジックとの整合

`App.tsx` line 80-84:
```tsx
useEffect(() => {
  if (!settingsLoading && !sspPath) {
    setSettingsOpen(true);
  }
}, [settingsLoading, sspPath]);
```

バリデーション失敗時に `onPathChange` が呼ばれない → `sspPath` が null のまま → ダイアログは正しく開き続ける。
**この部分の変更は不要。**

ただし、**既に有効なパスが設定されている状態**で別のフォルダを選択して失敗した場合、
エラーメッセージが表示されるだけで元のパスが維持されるという挙動を明示すること。

#### 波及的影響 ④：`ghost/` フォルダの確認も含めるか

SPEC §C-06 では「`ssp.exe` / `ghost/` の存在確認」と記述されている。
`ghost/` フォルダが存在しない場合は `scan_ghosts_with_meta` がエラーを返すため、
バリデーション段階で確認しておくとより親切。
ただし `ssp.exe` の確認だけでも実用上十分。スコープを絞ることを推奨する。

---

### T-5: CSP 設定の検討（C-03・優先度：中）

**変更箇所**: `src-tauri/tauri.conf.json` line 25

```json
"csp": null
```

#### 波及的影響 ①：Fluent UI v9（Griffel）との非互換性

Fluent UI v9 は **Griffel**（CSS-in-JS ライブラリ）を使用する。
Griffel は実行時に `<style>` タグを動的に挿入する（`makeStyles` の動作）。

`style-src 'self'` のみを許可する CSP を設定すると、Griffel が注入するスタイルが
全て CSP 違反でブロックされ **UI が完全に壊れる**。

回避策:
- `style-src 'self' 'unsafe-inline'` を許可する（セキュリティ上の妥協）
- Griffel のビルド時 CSS 抽出（Griffel の `@griffel/webpack-extraction-loader` 等）を利用する
  → Vite を使っているため互換性に要確認
- `nonce` を使う → Tauri 側で毎回 CSP nonce を発行する仕組みが必要（複雑）

**最も現実的な CSP（最低限）**:
```json
"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:"
```

`unsafe-inline` を `style-src` に含める必要があり、XSS リスクは限定的（ローカルアプリ）だが
SPEC §C-03 が意図する「セキュリティ強化」の効果が薄い点に留意。

#### 波及的影響 ②：Vite 開発サーバーとの非互換

`tauri.conf.json` の `devUrl` は `http://localhost:1420`（Vite HMR サーバー）。
開発時は `connect-src 'self' ws://localhost:1420` 等を追加しないと HMR が動かなくなる。
本番ビルドと開発設定を分けるか、CSP を開発時は null に保つ仕組みが必要。

---

### T-6: キャッシュエントリの有効期限/上限（C-05・優先度：低）

**変更箇所**: `src/lib/ghostCacheRepository.ts`

#### 波及的影響 ①：`cached_at` フィールドは既に存在

`GhostCacheEntry.cached_at: string`（ISO 8601）は既に保存されている。
有効期限チェックのためのスキーマ変更は**不要**。

#### 波及的影響 ②：エントリ膨張のシナリオ

`requestKey` は `normalizedSspPath::normalizedFolder1|normalizedFolder2|...` 形式。
SSP パスや追加フォルダを変更するたびに新しいキーが生まれ、古いエントリは残る。
通常使用では数個程度だが、パスを頻繁に変えると無制限に増える。

#### 波及的影響 ③：書き込みキューとの整合

`ghostCacheRepository.ts` は `cacheWriteQueue` で直列書き込みを行っている。
エントリ削除（pruning）を `writeGhostCacheEntry` の内部で行う場合、
同一キューで実行されるため並行問題は生じない。

#### 考慮もれ：エントリ上限の定義

上限値（例: エントリ数 10 件、または経過日数 30 日）を何に基づいて決めるかが未定義。
設定として外出しする必要はなく、定数として `ghostCacheRepository.ts` に埋め込めばよい。

---

### T-7: フロントエンドテスト基盤導入（C-07・優先度：低）

**変更箇所**: `package.json`, `vite.config.ts` または `vitest.config.ts`（新規）

#### 波及的影響 ①：Tauri API モックが必須

全てのカスタムフックおよび lib は `@tauri-apps/api/core` の `invoke` または
`@tauri-apps/plugin-store` の `LazyStore` を使用している。

テスト環境（Node.js / jsdom）では Tauri ランタイムが存在しないため、
**モックなしでは全テストが起動時エラーになる**。

必要なモック:
```
src/__mocks__/@tauri-apps/api/core.ts    → invoke を jest.fn() / vi.fn() で置換
src/__mocks__/@tauri-apps/plugin-store.ts → LazyStore をインメモリ実装で置換
src/__mocks__/@tauri-apps/plugin-dialog.ts → open/confirm を置換
```

#### 波及的影響 ②：`useGhosts.ts` の `inFlightKeyRef` / `requestSeqRef` ロジック

`useGhosts` は複数の `useRef` で競合検出を行っている複雑な非同期フック。
テストでは `@testing-library/react` の `renderHook` + `act` で非同期を適切にラップしないと
`requestSeq` が競合する。

#### 波及的影響 ③：CI への統合

SPEC §11.1 の CI ステップには `npm test` が含まれていない。
テスト基盤を追加する際は `ci-build.yml` にテスト実行ステップも追加する必要がある。

---

## タスク間依存関係マトリクス

| 実施順序 | 問題点 |
|----------|--------|
| T-3 → T-2 | T-3 で `compute_fingerprint_hash` を触った場合、T-2 で再度変更が必要になりえる |
| T-2 と T-3 を同時 | 最も安全。`compute_fingerprint_hash` の SHA-256 化とロジック統合を一括実施 |
| T-4 単独 | 新コマンド追加により `lib.rs` 変更。他タスクと衝突なし |
| T-5 単独 | `tauri.conf.json` のみ。コード変更なし。ただし Griffel 互換性を必ず検証すること |
| T-6 単独 | `ghostCacheRepository.ts` のみ。T-2 のキャッシュ無効化より後に実施推奨 |

---

## 追加で発見した問題（タスク外）

### X-1: `scan.rs` の追加フォルダ `parent` トークンのラベル不一致

`scan.rs` の `scan_ghosts_with_fingerprint_internal` では追加フォルダの `parent` トークンを:
```rust
format!("parent|{}|{}|missing", normalized_folder, normalized_folder)
// label = normalized_folder, path = normalized_folder
```

`fingerprint.rs` の `build_fingerprint` では:
```rust
push_parent_fingerprint_tokens(&mut tokens, &normalized_folder, &folder_path, false)
// label = normalized_folder, path = normalize_path(&folder_path) = normalized_folder
```

**現在は結果が一致している**（両方 `normalized_folder` を使用）が、
この対称性が暗黙の前提になっており、リファクタリング時に崩れやすい。
T-3 の統合時にこの一致を明示的に担保すること。

### X-2: `scan.rs` の存在チェック後のトークンと `fingerprint.rs` の不一致

`scan.rs` line 161-174 では `exists()` 判定 → トークン push が関数外部。
`fingerprint.rs` の `push_parent_fingerprint_tokens` は関数内部で `exists()` 判定。

T-3 で統合する際、どちらのパターンに統一するかを明確に決定すること。

### X-3: `GhostCacheStoreV1` のバージョン管理と T-2 の影響

T-2 のハッシュ変更によりキャッシュが全失効する。
これをユーザー向けに透明にするには:
- `version: 1` のままで失効（無言のフルスキャン）が最もシンプル。
- ただし SPEC の `version` フィールドの意義が失われる。

SPEC §4.3 では `version` フィールドを定義しているが、
バージョン変更によるマイグレーション処理は現在コードに存在しない。
T-2 実施時にどう扱うかの方針を決めること。

---

## 実装推奨順序

```
1. T-1: publish = false（即実施・影響なし）
2. T-2 + T-3 同時: SHA-256 移行 + ロジック統合（相互依存があるため同一 PR 推奨）
3. T-4: SSP パスバリデーション（独立・新コマンド設計が必要）
4. T-5: CSP 設定（Griffel 互換確認後）
5. T-6: キャッシュ有効期限（T-2 のキャッシュ無効化後が自然）
6. T-7: フロントエンドテスト基盤（CI 統合を含めて計画的に）
```

---

## ファイル影響一覧

| タスク | 変更ファイル |
|--------|-------------|
| T-1 | `src-tauri/Cargo.toml` |
| T-2 | `src-tauri/Cargo.toml` (sha2 追加), `fingerprint.rs` |
| T-3 | `fingerprint.rs`, `scan.rs` |
| T-4 | `SettingsPanel.tsx`, 新規コマンドファイル, `lib.rs` |
| T-5 | `tauri.conf.json` |
| T-6 | `ghostCacheRepository.ts` |
| T-7 | `package.json`, `vitest.config.ts`（新規）, モックファイル群（新規）, `ci-build.yml` |
