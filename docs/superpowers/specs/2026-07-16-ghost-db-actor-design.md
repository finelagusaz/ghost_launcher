# GhostDbActor ＋ 使い捨てスキーマ 設計書（issue #146）

> 承認済み設計（2026-07-16）に 4 観点マルチパースペクティブレビュー（並行性・SQLite・IPC/移行パス・
> アドバーサリアル）の findings を反映した改訂版。設計合意の経緯は issue #146 を参照。

## 1. 目的と背景

#134 の scan オフスレッド化（PR #145）で ghosts.db 周辺に集積した複雑さを、根源から除去する。
根源は 3 つ:

1. **導出キャッシュに 2 つの更新規律が混在** — 集計列への相対更新（record_launch の +1）と
   絶対上書き（scan backfill）の同居が、全 writer の相互排他問題（lost update）を生んだ
2. **排他が「構造」ではなく「規約」** — ScanCoordinator ロックは各コマンドのオプトイン方式で、
   「配線されているか」のランタイム検証装置一式（mock_builder・comctl32 マニフェスト・
   build.rs ハック・`<R>` 総称化・lock_wiring 統合テスト）を必要とした
3. **揮発キャッシュに永続データの機構** — sqlx チェックサム付きマイグレーションが
   migration 失敗 → ファイル削除 → fs 削除と open の物理競合の連鎖を生んだ

**効果測定は行数ではなくバグクラスの消滅で行う**（行数はほぼ中立の見込み）:
チェックサム衝突起動クラッシュ・fs 削除と open の物理競合・ロック配線漏れ・
タイミング依存テスト・スキーマ version bump 忘れ、の 5 クラスが対象。

## 2. アーキテクチャ

```
JS（SQL 文レベルで書込ゼロ）           Rust
┌─────────────────┐                  ┌──────────────────────────────┐
│ searchGhosts 等  │─ sqlx SELECT ──▶│ ghosts.db                    │
│ invoke(...) ────────┐              │   ▲ SQL 書込は唯一この接続     │
└─────────────────┘   │              │ ┌─┴────────────────────────┐ │
                      ▼              │ │ GhostDbActor（専有スレッド）│ │
        ┌──────────────────────┐     │ │  owns: ghosts_conn        │ │
        │ コマンド（薄い皮）      │────▶│ │        user_data_conn     │ │
        │ scan/record/cleanup   │ Job │ │  mpsc 受信 → 逐次実行      │ │
        └──────────────────────┘◀────│ │  oneshot で結果返信        │ │
                                 応答 │ └──────────────────────────┘ │
                                     └──────────────────────────────┘
```

### 2.1 構築（setup 内・webview ロード前・すべて同期）

順序は不変条件。**(2) が (3) より先** でなければ、旧世代（migration 11〜12）からの
アップグレードで永続の起動履歴が複写前に DROP され失われる（issue #93 の不変条件違反）:

1. パス解決（`db_path` 単一権威で 1 回）と最小 sanitize: ghosts.db が **open 不能（破損）なら
   fs 削除**（webview 前なので物理競合なし）
2. `init_user_data`: user-data.db 初期化＋ **legacy `ghost_launches` の移送**
   （`migrate_legacy_launch_history`、現行どおり温存）
3. ghosts_conn を open → PRAGMA 設定 → **`ensure_cache_schema`**（§4）
4. ghosts_conn / user_data_conn を **move** してアクタースレッドを起動
   （`rusqlite::Connection` は `Send`。setup スレッドで完了させてから move するため、
   起動ハンドシェイクなしで「webview 前にスキーマ確定」が構造的に成立する）
5. `ActorHandle(Sender<Job>)` を `.manage()`。直後に `Maintenance` ジョブ（§5.2）を self-enqueue

**bootstrap の失敗は起動中止（fail-fast・裁定済み）**: 旧 setup は DB 初期化失敗でも劣化継続したが、
アクター不在では全コマンドが State 参照で成立しないため劣化モードは現アーキテクチャで無意味。
よくある破損クラスは open_with_recovery の fs 削除リトライが回収済みで、ここに到達する失敗は
disk full・権限等の環境障害のみ。壊れたまま動くより loud に落ちて診断可能にする。

### 2.2 実行と終了

- チャネルは **unbounded**（送信は非ブロッキング。writer は UI 起点で実質有限のため
  無制限成長はしない）。応答待ちは oneshot の await のみ
- 長時間 Scan がキューを塞ぐ間、後続ジョブは待つ（現行ロック方式と等価。悪化ではない）
- 受信ループは**チャネルクローズ（全 Sender drop）で終了**する。プロセス終了時の
  in-flight ジョブは SQLite のトランザクション原子性に委ねる。**キュー滞留中の
  RecordLaunch がプロセス終了で失われることは許容する**（現行ロック方式でも
  spawn_blocking 待ちの record_launch は終了で消えるため悪化ではない）
- **二重起動（クロスプロセス）は本設計のスコープ外**: 単一 writer はプロセス内の保証。
  プロセス間は現行同様 WAL＋busy_timeout＋fingerprint 冪等性で実害を許容する
  （single-instance 化は将来課題）

### 2.3 writer 混入の構造ガード（「型が保証」の実体）

`Job` enum は既知 writer の列挙であって未知 writer の禁止ではない。
`rusqlite::Connection::open` は誰でも書けるため、以下 2 点で構造的に封じる:

1. **可視性封鎖**: `db_path::ghost_db_path` / `GHOST_DB_FILES` をアクターモジュール専有の
   可視性（`pub(in ...)`）へ落とす。sanitize・アクター構築は同モジュールに同居させる。
   コマンド層からは ghosts.db の**パス解決自体が不可能**になる
2. **lint 保険**: `clippy.toml` の `disallowed-methods` で actor モジュール外の
   `rusqlite::Connection::open` を禁止する

この 2 点が lock_wiring 一式（§6）の撤去を正当化する根拠であり、Phase 2 の完了条件に含める。

## 3. Job enum（writer の全列挙）

```rust
enum Job {
    Scan { ssp_path, additional_folders, request_key, cached_fingerprint, reply },
    RecordLaunch { ghost_identity_key, reply },
    CleanupCaches { current_request_key, reply },
    Maintenance,  // 条件付き VACUUM + PRAGMA optimize（reply 不要・起動直後に self-enqueue）
}
```

- **enum を選ぶ理由**: 「ghosts.db への書き込みの全種類」が 1 箇所に列挙され、match の
  網羅性チェックが新 writer の追加を強制的に可視化する（未知 writer の禁止は §2.3 が担う）
- **`Reset` ジョブは置かない**: 現行 `reset_ghost_db` の唯一の呼び出し元は JS の
  migration エラー回復パスであり、本設計でエラークラスごと消滅して呼び出し元ゼロになる。
  YAGNI によりコマンドごと撤去する（§6）。手動リセット UI が要件化したら
  「`ensure_cache_schema` の強制実行ジョブ」として追加する
- **Scan ジョブは walk＋parse＋DB 適用の全体**を実行する（scan 全体の直列化を維持。
  DB 適用だけのジョブ化では 2 scan が同じ prev から差分計算する lost update が復活する）。
  rayon 並列 parse はジョブ内部でそのまま使う
- record_launch の相対 bump はアクター直列化の下で再び安全なため、絶対値導出への統一は
  行わない（YAGNI）

### 3.1 panic・キャンセル・切断の不変条件

- ジョブの DB 作業は `catch_unwind`（`AssertUnwindSafe`）で包み、panic はエラー応答へ変換して
  アクターは生存する（Mutex poison 回復の後継）。**reply Sender は catch_unwind の外に
  destructure してから包む**（panic 時に Sender が unwind で drop されると呼び出し側が
  Err でなく RecvError を受けるため）
- **接続健全性の不変条件**: 複数文の書き込みは必ず RAII `Transaction`
  （`unchecked_transaction` 等）経由とし、`execute_batch("BEGIN; ...")` の手動
  トランザクションを禁止する。防御として panic 捕捉後に `conn.is_autocommit()` を検査し、
  false なら ROLLBACK して継続する（アクター生存 ≠ 接続健全のギャップを塞ぐ）
- アクターループ本体（recv 処理）には unwrap を置かず panic フリーに保つ
  （ループ死＝全書き込みコマンドの恒久エラー化を防ぐ）
- **reply の drop（呼び出し側キャンセル）は無視**し、ジョブは常に完走する（DB 状態は適用済み）
- コマンド側は `Sender::send` の Err／oneshot の RecvError を `Result<_, String>` の
  エラーへ写像する（panic しない）

## 4. 使い捨てスキーマ

```rust
/// CACHE_SCHEMA 文字列の FNV-1a ハッシュを i32 に畳んだ値（0 なら 1 にずらす）。
/// スキーマ本文の変更＝自動リビルド。手動 bump が存在しないため「bump 忘れ」クラスが
/// 構造的に消滅する（空白変更でも全ユーザー再スキャンになるが、受容済みトレードオフと同型）。
fn cache_schema_version() -> i32 { fnv1a(CACHE_SCHEMA) }

const CACHE_SCHEMA: &str = "CREATE TABLE ghosts (...); ...";  // 現行 migration 15 本の合成結果

fn ensure_cache_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    // PRAGMA user_version != cache_schema_version() なら単一トランザクションでリビルド
}
```

- **リビルドは `BEGIN IMMEDIATE; DROP...; CREATE...; PRAGMA user_version=N; COMMIT;` の
  単一トランザクション**で行う（不変条件）。WAL では writer は reader にブロックされず、
  reader は COMMIT まで旧スナップショットを見続けるため「no such table」窓が存在しない。
  DDL も user_version もトランザクショナルなので、リビルド途中のクラッシュは旧スキーマ＋
  旧 user_version に自動復元され、次回起動で再試行される
- **DROP 対象から `sqlite_%` 内部テーブルを除外**する（`sqlite_sequence`・`sqlite_stat1` は
  DROP 不可。`name NOT LIKE 'sqlite_%'` フィルタ必須）。`_sqlx_migrations` は DROP する
  （`add_migrations` 登録を外した後の tauri-plugin-sql は同テーブルを一切参照しない: 検証済み）
- 既存ユーザーは `user_version=0`（sqlx は設定しない）→ 初回起動で自動リビルド＝移行完了。
  **前提として §2.1 の順序（legacy 移送が先）を厳守**
- **user-data.db は現行のまま**（`ensure_schema` の追加式・絶対に DROP しない）
- **起動時の ensure_cache_schema 失敗は fs 削除リトライ 1 回で回収する**（レビュー指摘の裁定）:
  sqlx migration 層の撤去でスキーマ修復経路が単一層化するため、起動時（webview 前・fs 削除が
  安全な唯一のタイミング）に失敗したら GHOST_DB_FILES を削除して作り直しを 1 回だけ試行する。
  2 回目の失敗（disk full・権限等）は eprintln のみで起動を続行する（キャッシュ不能でも
  アプリは動かす）。この回復は Phase 1 の `init_cache_schema` と Phase 2 の `bootstrap` の両方に置く
- **実行時破損の回復は次回起動へ委ねる**（受容宣言）: 稼働中に SQLITE_CORRUPT 級の破損が
  起きた場合、本設計にはランタイム回復手段がない（旧方式は JS 回復パス→fs 削除が効いた）。
  次回起動の sanitize＋上記リトライが回収する。頻度極小のため許容する
- **ダウングレード**: リビルド済み DB（`_sqlx_migrations` 不在）を旧バージョンで開くと、
  旧 `Database.load` が migration エラー→旧 `reset_ghost_db`（fs 削除）→再スキャンで復旧する
  見込み（低頻度のため実装では検証しない。ここに挙動想定を記録するに留める）
- **受け入れ済みトレードオフ**: スキーマを変えるリリースは全ユーザーのキャッシュ破棄＝
  初回フルスキャン。スキーマ変更は稀で、#134 の進捗 UI＋オフスレッド化が UX をカバー済み

## 5. JS の読み取り専用化

### 5.1 cleanup のコマンド化

- `cleanupOldGhostCaches`（世代 5・TTL 30 日ポリシー、`ghostDatabase.ts:95-132`）→
  `CleanupCaches` ジョブへ移植。ポリシー定数（世代数・TTL）は Rust 側 const にする
  （現行 JS の引数は テストからしか変えられないため IPC 引数にしない: YAGNI）
- **新コマンド契約**: `cleanup_ghost_caches`
  | 項目 | 内容 |
  |---|---|
  | 引数 | `currentRequestKey: string`（→ `current_request_key`） |
  | 戻り値 | `number`（削除した request_key 数。JS はログにのみ使用） |
  | エラー | 呼び出し元 `ghostCatalogService.ts:53` は現行同様 fire-and-forget + catch でログのみ |
- ポリシーのユニットテスト（`ghostDatabase.test.ts` の 4 本: 世代上限・TTL・current 保護・
  全削除）は Rust 側へ移植する

### 5.2 メンテナンスの移動

- `VACUUM`／`PRAGMA optimize` → `Maintenance` ジョブ（§3）へ移動。**現行の閾値判定
  （未使用率 25%↑ かつ 1MB↑）を維持**し、失敗はログのみで続行（現行 try-catch 踏襲）。
  実行はアクター起動直後の self-enqueue で、**webview ロードも setup もブロックしない**
  （VACUUM はトランザクション内で実行不可のため §4 の単一 tx とは独立のステップ）
- JS `loadDb` に残す PRAGMA: `busy_timeout` のみ（読者に必要。なお sqlx-sqlite 0.8 は
  接続確立時にデフォルト 5 秒の busy_timeout を全プール接続へ適用済みで、JS の明示 PRAGMA は
  保険。sqlx 更新でデフォルトが変わった際の注意点としてここに記録する）。
  `journal_size_limit` はアクター接続の PRAGMA（`configure_connection`）へ移設する。
  `journal_mode=WAL` はファイル永続属性のためアクター側の設定で足りる
- `searchGhosts` 等の SELECT ホットパスは sqlx のまま**不変**（仮想スクロールの
  ページング性能に触れない）
- 「読み取り専用」の主張は **SQL 文レベル**のスコープ（WAL 読者も -shm 作成等の
  ファイル I/O は行う）

## 6. 撤去されるもの

| 撤去対象 | 理由 |
|---|---|
| `ScanCoordinator`・`run_serialized`・poison 回復 | 排他が構造化され Mutex 自体が不要 |
| `lock_wiring.rs`・comctl32 manifest・`build.rs` link-arg・tauri `test` feature・`#[doc(hidden)] pub use` | 配線検証が不要（§2.3 の可視性封鎖＋lint が代替。これが撤去の前提条件） |
| `<R: Runtime>` 総称化×4 関数 | ジョブが AppHandle 非依存 |
| sqlx migration 15 本の**本番登録**（`add_migrations`） | スキーマが使い捨て。**SQL 本体は §8 の一致テスト専用コードとして温存**（純撤去ではなく移設） |
| `sanitize_ghost_db`／`has_migration_conflict` | チェックサム衝突のバグクラス消滅（「open 不能→fs 削除」の最小 sanitize に縮退） |
| `reset_ghost_db` コマンド（Rust）＋ JS `initializeDb` の回復ロジック＋テスト | 呼び出し元（migration エラー回復）ごとバグクラスが消滅し、呼び出し元ゼロの死蔵コマンドになるため（YAGNI） |
| 「ロックのメンバー」の 5 箇所ドキュメント同期 | writer 列挙が `Job` enum に一元化 |

## 7. フェーズ構成（単一 PR）

1. **Phase 1（使い捨てスキーマ）**: `ensure_cache_schema`（単一 tx・ハッシュ version）＋
   一致テスト＋sqlx migration 登録撤去＋`reset_ghost_db`／JS 回復パス撤去＋最小 sanitize 化。
   起動順序（§2.1）をこのフェーズで確立（ロック方式のまま）
2. **Phase 2（アクター）**: GhostDbActor 導入、scan/record_launch をジョブ化、
   §2.3 の可視性封鎖＋clippy lint、ScanCoordinator と lock_wiring 一式を撤去
3. **Phase 3（JS 読み取り専用化）**: `cleanup_ghost_caches` コマンド化・`Maintenance` ジョブ
   （VACUUM/optimize 移動・`journal_size_limit` 移設）

各フェーズでテスト先行。全フェーズ完了後に一括 PR（プロジェクト規約）。

**SPEC.md 同期対象**（PR に含める）: §4.3/§4.4（migration 前提の記述）・§6.4（reset_ghost_db
削除）・§6.6（record_launch の直列化記述をアクターへ）・§8.1（cleanup の invoke 化・手順 6）・
§8.1.1（PRAGMA 責務分担）・§13（マイグレーション競合行の削除）・§6.x に cleanup_ghost_caches
追加。ルート/src-tauri の CLAUDE.md（マイグレーション規約の ghosts.db 適用分）も更新。

## 8. リスクと対策

- **最大リスク**: `CACHE_SCHEMA` 1 枚と旧 migration 15 本の合成結果の一致。
  **対策（二段構え）**:
  1. `PRAGMA table_info`＋`index_list`/`index_info`＋`foreign_key_list` の構造比較
  2. `sqlite_master.sql` の**正規化テキスト比較**（インデント・改行を正規化して diff。
     COLLATE・CHECK・部分インデックス述語・トリガーは PRAGMA に現れないため必須）
  旧 `migrations()` はこのテスト専用に温存する。**テストの寿命**: スキーマを初めて変更する
  リリース（ハッシュ version が変わる時点）で役目を終え、旧 `migrations()` ごと削除する
- **起動順序**: §2.1 の 5 ステップが唯一の順序。特に「legacy 移送 → ensure_cache_schema」は
  永続データ保護の不変条件（違反すると issue #93 の回帰）
- **IPC 契約**: scan_and_store／record_launch の引数・戻り値は不変。`reset_ghost_db` は
  呼び出し元ごと削除。新規は `cleanup_ghost_caches` のみ（§5.1 の契約。/ipc-check 対象）
- **OneDrive 等の同期フォルダ**: `app_config_dir`（Roaming AppData）は既定でクラウド同期
  対象外。同期ソフトが WAL に介入する環境はサポート外とする（現行と同じ・記録のみ）

## 9. テスト戦略

- **アクター**（一時ファイル 2 つの純ユニットテスト）:
  - 並行ジョブ投入 → 直列実行の整合（現行 `scan_lock配下の並行delta` テストの後継）
  - panic ジョブ → アクター生存 **かつ次のジョブが成功する**（接続健全性・§3.1）
  - reply drop（受信側 drop）でもジョブが完走しアクターが継続する
  - 全 Sender drop → 受信ループが終了する（スレッドリークなし）
- **スキーマ**:
  - 旧 migration 合成との一致（§8 の二段構え）
  - user_version 不一致 → リビルド／一致 → データ保持
  - **リビルド実行中の並行 reader が「no such table」を観測しない**（単一 tx の検証）
  - **legacy 移送 → リビルドの順序**: 旧世代 DB（migration 11 相当＋履歴あり）からの
    起動シーケンスで、リビルド後も user-data.db に履歴が残る（issue #93 回帰ガードの拡張。
    現行 `アップグレードとリセットを通じて…` テストを新方式へ改修）
- **cleanup**: JS の 4 テスト（世代上限・TTL・current 保護・全削除）を Rust へ移植
- **JS**: `ghostCatalogService.test.ts` のモックを `invoke` ベースへ更新。
  `ghostDatabase.test.ts` の `initializeDb` 回復パステスト（2 本）と cleanup ポリシーテスト
  （4 本・Rust へ移植済み）を削除
