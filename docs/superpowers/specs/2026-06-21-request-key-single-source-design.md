# request_key を単一権威（フロントエンド）に集約する設計

- 日付: 2026-06-21
- 種別: リファクタリング（構造的バグクラスの根絶）
- 関連: `fix/request-key-sort-collation`（ソート照合不一致の暫定修正）の構造的後継
- レビュー: IPC 境界 / エンコーディング / SQLite・キャッシュ / アーキテクチャの 4 観点で並列レビュー済み（2026-06-21、全員 blocker なし・GO with changes）。指摘は本書に反映済み。

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

- `scan_and_store` に引数 `request_key: String`（非 Option。JS から camelCase `requestKey` で渡り snake_case に変換される）を追加する。JS 単一権威のため常に値が渡る前提。
- **空キーガード（defense-in-depth）**: 受領した `request_key` が空文字なら早期に `Err` を返す。新設される信頼境界（Rust が JS 由来の鍵を無検証で使う）の最小防御。将来 JS のバグで空キーが渡ると全ゴーストが `request_key=''` パーティションに同居する事故を防ぐ。
- **削除**: `mod.rs:26-31` の鍵構築ブロック（`normalize_path(sspPath)` + `unique_sorted_additional_folders` を鍵用途で呼び `format!` する部分）。以降は引数 `request_key` を使う。
- `ScanStoreResult.request_key` は**受け取った値をそのまま echo する**。戻り値の形は不変。
- `unique_sorted_additional_folders` と `normalize_path` は**走査用途で残す**（`source` ラベル付け・走査時の dedup。`scan_ghosts_with_fingerprint_internal` が使用）。鍵から切り離されるため、もはやクロス言語の一致責任を負わない。
- `mod.rs:26` の「JS 側の `buildRequestKey` と同一ロジック」コメント（現状は虚偽）を削除する。

### JS（`src/lib/ghostCatalogService.ts` ほか）

- `ghostCatalogService.ts:36-40` の invoke 呼び出しに、既に算出済み（同 line 23）の `requestKey` を**実際に渡す**:
  `invoke("scan_and_store", { sspPath, additionalFolders, requestKey, cachedFingerprint })`。現状は計算しているのに未送出のため、送出箇所の修正が核心。
- IPC 契約型は手書きの `src/lib/dbMonitor.ts` の `ScanStoreResult`（ts-rs 生成型 `src/types/generated/ScanStoreResult.ts` は未使用）。echo はこの手書き型の形を変えないため安全。
- **読み出し側の集約**: `requestKeyFromSettings(sspPath, ghostFolders)` ヘルパーを `ghostScanUtils.ts` に新設し、`buildRequestKey(sspPath, buildAdditionalFolders(ghostFolders))` を繰り返す 3 箇所（`ghostCatalogService.ts:23`、`App.tsx:103`、`useGhosts.ts:27`）を置換する。`buildAdditionalFolders` の付け忘れを構造的に防ぎ、「単一権威」を関数レベルで保証する（CLAUDE.md の DRY 方針に合致）。
- `cleanupOldGhostCaches` の引数は echo された `result.request_key` ではなく JS ローカルの `requestKey` を使い、echo への依存を断つ。

## 互換性・移行

- 既存 DB は `fix/request-key-sort-collation` 適用後、**JS 鍵 = 格納鍵**が成立済み（実データで `MATCH: true` を確認済み。ただし検証は ASCII/BMP パス範囲。サロゲートペア U+10000 以上を含むパスは JS の `<`＝UTF-16 コードユニット順と旧 Rust の UTF-8 バイト順が逆転しうるが、下記の自己修復に委ねる）。本変更後も JS は同じ鍵を渡すため、典型環境では**再スキャン不要・シームレス**に既存キャッシュを利用できる。
- 仮に末尾スラッシュ・空白・サロゲートで鍵がずれている環境でも、鍵が一つになるため**再スキャン一回で自己修復**する。根拠連鎖は: `hasGhosts(新キー)=false`（`ghostCatalogService.ts:28-30`）→ `cachedFingerprint=null` → Rust は `cached_fingerprint.is_some()` が false で Layer 1 をバイパス（`mod.rs:46`）→ Layer 2 フルスキャン → 新キーで書き込み。「DB が新キーで空」という条件が Layer 1 のスキップを強制するため、自己修復は構造的に成立する。
- ただし旧キーのパーティション行は即時には消えず、`cleanupOldGhostCaches`（世代 `maxGenerations=5` ＋ TTL `ttlDays=30`、`ghosts`/`ghost_fingerprints` 双方を掃除）が遅延回収する。新キーの読み出しは即座に正しく動くためユーザー影響はないが、「シームレス」は読み出しの話で、旧データの物理削除は遅延する。

## テスト（TDD）

- **JS** `src/lib/ghostCatalogService.test.ts`:
  - `forceFullScan` の完全一致アサーション（line 83-88）に `requestKey` を追加する。
  - 「`scan_and_store` に渡る `requestKey` が `requestKeyFromSettings(sspPath, ghostFolders)` の出力と一致する」テストを追加（Red → Green）。
- **JS** `src/lib/ghostScanUtils.test.ts`:
  - 新設 `requestKeyFromSettings` のテスト（内部で `buildAdditionalFolders` を通すこと、`buildRequestKey` と等価な出力）。
  - 日本語・全角を含む追加フォルダ名で `requestKeyFromSettings` が安定出力を返すケースを 1 件追加（将来 NFC 正規化やソート変更時の回帰検知）。
- **Rust**: 鍵構築は削除のため新規ロジックなし。新規は**空キーガードのテスト 1 件**（`request_key=""` で `Err`）のみ。`store_ghosts` が渡された鍵で格納することは既存テスト（`store.rs`）で担保済み。署名変更に伴うコンパイル整合。

## ドキュメント同期

- `SPEC.md` を「フロントが唯一計算、Rust は受領」へ更新する。対象は §4.5 だけでなく **§7.3（追加フォルダの正規化）/ §8.1（キャッシュフロー。§8.1.3 の `scan_ghosts_with_meta(cachedFingerprint)` は現実装の `scan_and_store` と既にズレており、本変更で `requestKey` 引数も増える）** を含む。
- `src-tauri/CLAUDE.md` の `request_key` 関連記述を更新する。
- **コメント負債の解消**: `ghostScanUtils.ts:10-13` と `ghostScanUtils.test.ts:26-29` の「Rust 側 `String::cmp` とソート順を一致させる」コメントを「JS 内部の決定的順序のため」へ更新する（Lv1 後は Rust と一致させる理由が消えるため）。`store.rs:15` の「JS 側の `buildGhostIdentityKey` と同一ロジック」コメントは `mod.rs:26` 同様に対応する JS 関数が存在せず虚偽の疑いがあるため精査・修正する。

## スコープ外（YAGNI）

- `normalize_path` の trim / 末尾スラッシュ調整はしない（鍵から切り離されるため一致責任が消え、無関係になる）。フォルダ表記揺れの dedup 改善は別件。
- **`request_key` への NFKC 非適用は意図的に維持する**。`request_key` は単一の設定ソース（`ssp_path`/`ghost_folders`、UI 入力・ファイルダイアログ由来でほぼ NFC 固定）から JS が一度だけ導出するため、書き込み/読み出しで同じ正規化形が保証される。NFKC を当てると全角/半角を誤統合して別フォルダを同一視する危険があるため避ける。将来 macOS 横断対応時は、NFKC ではなく **NFC**（`.normalize("NFC")`）の付与を別件 TODO とする。
- **`ghost_identity_key` は対象外**。`store.rs` の `normalize_for_key`/`build_ghost_identity_key` は一見 `request_key` と同型の二重実装に見えるが、Rust が計算して DB 列に書き、JS は列値を読むだけで再計算しない（`recordLaunch` も DB 由来値を渡す）。既に単一権威であり本件の対象ではない。
- 検索クエリ正規化（`ghostDatabase.ts` の `normalizeForKey` ↔ `store.rs` の `normalize_for_key`）は `request_key` と同型のクロス言語二重導出が残るが、検索は Rust 非経由（直接 SQL 読み）のため単一権威化できない。必要ならパリティテストで縛る別件とする。
- Lv2（DB アクセスを全て Rust に集約し、フロントは `query_ghosts` IPC のみにする）には踏み込まない。現行の直接 SQL 読みによる検索応答性の利点を捨てるため、本件では採用しない。

## 却下した代替案

- **Lv0（個別差分つぶし + クロス言語パリティテスト）**: trim・末尾スラッシュを揃え、両実装の出力一致をテストで縛る。症状は止まるが二重導出は残り、将来のドリフト余地が残る。
- **Lv1a（Rust 権威）**: Rust が唯一計算し JS は不透明トークンとして受領。筋は通るが読み出し経路に IPC 依存を足し、コードは減らない。
- **Lv2（DB アクセスの Rust 集約）**: 抽象の漏れも根絶するが大がかりで、検索の打鍵ごとに IPC が発生する。
