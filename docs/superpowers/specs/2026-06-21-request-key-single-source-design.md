# request_key を単一権威（フロントエンド）に集約する設計

- 日付: 2026-06-21
- 種別: リファクタリング（構造的バグクラスの根絶）
- 関連: `fix/request-key-sort-collation`（ソート照合不一致の暫定修正）の構造的後継

## 背景と問題

`request_key` はゴーストキャッシュの**分割キー**である。形式は
`{normalize(sspPath)}::{正規化・整列・dedup したフォルダ群を | 連結}`。

このキーが**書き込み側（Rust `scan_and_store`）と読み出し側（JS）で独立に二重導出**されており、両者の一致は実装の暗黙の合意だけで担保されている。実際に分岐が複数発見された:

- **ソート照合**: JS `localeCompare`（ロケール依存）と Rust `String::cmp`（コードポイント順）で `ghost2`/`ghost_dev` の順が逆転 → `fix/request-key-sort-collation` で JS をコードポイント順に修正済み。
- **末尾スラッシュ**: JS は除去、Rust は保持（`C:\x\` → JS `c:/x` / Rust `c:/x/`）。
- **前後空白**: JS は `trim()`、Rust はしない。

### 不変条件（破られていたもの）

> 同一の設定から、JS が読み出しに使う `request_key` と Rust が書き込みに使う `request_key` は、常に一字一句一致しなければならない。

### なぜ致命的か（自己修復しない）

キーがずれると、再スキャンしても Rust は自分の鍵で書き、JS は自分の鍵で読む。両者は永遠に交わらず、「インデックスにデータがあるのにゴースト一覧が空」という症状が**永続化**する。この「治らなさ」は、二重導出という構造そのものが生んでいる。

### 構造的診断

- **真実の源泉が二重（DRY 違反が言語境界をまたぐ）**: 正規化・整列・dedup・連結が Rust/JS に二重実装され、片方を触れば即ドリフトする時限式の同型バグ。
- **抽象の漏れ**: `request_key` は本来「キャッシュをどう分割したか」というバックエンドの内部実装詳細。それがフロントに漏れ、フロントが分割キーの作り方を知ってしまっている。
- **設計の途中固着**: `scan_and_store` がキーを返すのは「Rust が権威」という当初設計の名残。stale-while-revalidate（commit 8c3c311）で JS が独自計算を始め、結果「両方が権威」という最悪の中間状態に陥った。

## 決定

**Lv1: 単一の真実の源泉に集約する。`request_key` をフロントエンド（JS）が一度だけ計算し、`scan_and_store` に値として渡す。Rust は受け取った値をそのまま使い、自前計算をやめる。**

`request_key` は Rust にとって**不透明トークン**になる。計算が一箇所しか存在しなくなるため、一致が「振る舞い」ではなく「構造」で保証される。

### なぜ JS が権威か（Rust 権威案ではなく）

- 起動時の即時キャッシュ表示（stale-while-revalidate）は、JS 側計算なら IPC 往復ゼロで維持できる。Rust 権威にすると読み出し前に `compute_request_key` IPC が必要になり、読み出し経路に依存と遅延を**足す**ことになる。
- JS 権威案は Rust の鍵構築コードを**削除**でき、正味でコードが減る（KISS）。

## アーキテクチャ（データフロー）

```
変更前: settings ──┬─→ JS  が request_key 計算 → 読み出しクエリ
                   └─→ Rust が request_key 計算 → 書き込み      （二つの権威が衝突）

変更後: settings ──→ JS が request_key 計算（唯一の源泉）
                       ├─→ 読み出しクエリ（App.tsx / useGhosts / ghostDatabase）
                       └─→ scan_and_store に「値」として渡す → Rust はそのまま使う
```

## 具体的な改変

### Rust（`src-tauri/src/commands/ghost/mod.rs`）

- `scan_and_store` に引数 `request_key: String` を追加する（JS から camelCase `requestKey` で渡り snake_case に変換される）。
- **削除**: `mod.rs:26-31` の鍵構築ブロック（`normalize_path(sspPath)` + `unique_sorted_additional_folders` を鍵用途で呼び `format!` する部分）。以降は引数 `request_key` を使う。
- `ScanStoreResult.request_key` は**受け取った値をそのまま echo する**。戻り値の形は不変のため、消費者（`cleanupOldGhostCaches(result.request_key)`）や ts-rs 生成型に波及しない。
- `unique_sorted_additional_folders` と `normalize_path` は**走査用途で残す**（`source` ラベル付け・走査時の dedup。`scan_ghosts_with_fingerprint_internal` が使用）。鍵から切り離されるため、もはやクロス言語の一致責任を負わない。
- `mod.rs:26` の「JS 側の `buildRequestKey` と同一ロジック」コメント（現状は虚偽）を削除する。

### JS（`src/lib/ghostCatalogService.ts`）

- 既に計算済みの `requestKey` を invoke 引数に追加するのみ:
  `invoke("scan_and_store", { sspPath, additionalFolders, requestKey, cachedFingerprint })`。

## 互換性・移行

- 既存 DB は `fix/request-key-sort-collation` 適用後、**JS 鍵 = 格納鍵**が成立済み（実データで `MATCH: true` を確認済み）。本変更後も JS は同じ鍵を渡すため、**再スキャン不要・シームレス**に既存キャッシュを利用できる。
- 仮に末尾スラッシュ・空白で鍵がずれている別環境でも、鍵が一つになるため**再スキャン一回で自己修復**する。失われていた自己修復能力が構造的に回復する。

## テスト（TDD）

- **JS** `src/lib/ghostCatalogService.test.ts`:
  - `forceFullScan` の完全一致アサーション（現 line 83-87）に `requestKey` を追加する。
  - 「`scan_and_store` に渡る `requestKey` が `buildRequestKey(sspPath, buildAdditionalFolders(ghostFolders))` の出力と一致する」テストを追加（Red → Green）。
- **Rust**: 鍵構築は削除のため新規ロジックなし。`store_ghosts` が渡された鍵で格納することは既存テスト（`store.rs`）で担保済み。署名変更に伴うコンパイル整合のみ。

## ドキュメント同期

- `SPEC.md`（`request_key` の §4.5 付近）を「フロントが唯一計算、Rust は受領」へ更新する。
- `src-tauri/CLAUDE.md` の `request_key` 関連記述を更新する。

## スコープ外（YAGNI）

- `normalize_path` の trim / 末尾スラッシュ調整はしない（鍵から切り離されるため一致責任が消え、無関係になる）。フォルダ表記揺れの dedup 改善は別件。
- Lv2（DB アクセスを全て Rust に集約し、フロントは `query_ghosts` IPC のみにする）には踏み込まない。現行の直接 SQL 読みによる検索応答性の利点を捨てるため、本件では採用しない。

## 却下した代替案

- **Lv0（個別差分つぶし + クロス言語パリティテスト）**: trim・末尾スラッシュを揃え、両実装の出力一致をテストで縛る。症状は止まるが二重導出は残り、将来のドリフト余地が残る。
- **Lv1a（Rust 権威）**: Rust が唯一計算し JS は不透明トークンとして受領。筋は通るが読み出し経路に IPC 依存を足し、コードは減らない。
- **Lv2（DB アクセスの Rust 集約）**: 抽象の漏れも根絶するが大がかりで、検索の打鍵ごとに IPC が発生する。
