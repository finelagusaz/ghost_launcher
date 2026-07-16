# GhostDbActor ＋ 使い捨てスキーマ 設計書（issue #146）

> 承認済み設計（2026-07-16）。設計合意の経緯と全文は issue #146 を参照。

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

方針: 「時間の問題を時間で解く」（ロック・タイミングテスト）のをやめ、構造（所有権）と
冪等性（使い捨てスキーマ）に置き換える。

## 2. アーキテクチャ

```
JS（完全に読み取り専用）                Rust
┌─────────────────┐                  ┌──────────────────────────────┐
│ searchGhosts 等  │─ sqlx SELECT ──▶│ ghosts.db                    │
│ invoke(...) ────────┐              │   ▲ 書き込みは唯一この接続     │
└─────────────────┘   │              │ ┌─┴────────────────────────┐ │
                      ▼              │ │ GhostDbActor（専有スレッド）│ │
        ┌──────────────────────┐     │ │  owns: ghosts_conn        │ │
        │ コマンド（薄い皮）      │────▶│ │        user_data_conn     │ │
        │ scan/reset/record/    │ Job │ │  mpsc 受信 → 逐次実行      │ │
        │ cleanup               │◀────│ │  oneshot で結果返信        │ │
        └──────────────────────┘ 応答 │ └──────────────────────────┘ │
                                     └──────────────────────────────┘
```

- アクターは `(ghosts_path, user_data_path)` から構築する。パス解決は setup で 1 回。
  **AppHandle 非依存**のため、テストは一時ファイル 2 つの純ユニットテストで書ける
- `ActorHandle(Sender<Job>)` を `.manage()` する。コマンドは Job を送って oneshot を
  await する薄い皮（`spawn_blocking`・ロック・`<R>` 総称化は消滅）
- 排他は「キューの消費者が 1 人」という構造そのもの。`Connection` がアクター外に
  存在しないため、ロックの取り忘れに相当するコードはコンパイルエラーになる

## 3. Job enum（writer の全列挙）

```rust
enum Job {
    Scan { ssp_path, additional_folders, request_key, cached_fingerprint, reply },
    Reset { reply },
    RecordLaunch { ghost_identity_key, reply },
    CleanupCaches { current_request_key, reply },
}
```

- **enum を選ぶ理由**: 「ghosts.db への書き込みの全種類」が 1 箇所に列挙され、match の
  網羅性チェックが新 writer の追加を強制的に可視化する。#145 のロック漏れ事故の根因
  「writer の列挙がドキュメントにしかなかった」ことへの本質対策
- **Scan ジョブは walk＋parse＋DB 適用の全体**を実行する（scan 全体の直列化を維持。
  DB 適用だけのジョブ化では 2 scan が同じ prev から差分計算する lost update が復活する）。
  rayon 並列 parse はジョブ内部でそのまま使う
- ジョブは `catch_unwind` で包み、panic はエラー応答へ変換してアクターは生存する
  （Mutex poison 回復の後継）
- record_launch の相対 bump はアクター直列化の下で再び安全なため、絶対値導出への統一は
  行わない（YAGNI）

## 4. 使い捨てスキーマ

```rust
const CACHE_SCHEMA_VERSION: i32 = 1;
const CACHE_SCHEMA: &str = "CREATE TABLE ghosts (...); ...";  // 現行 migration 15 本の合成結果

fn ensure_cache_schema(conn: &rusqlite::Connection) {
    // PRAGMA user_version != CACHE_SCHEMA_VERSION なら
    // _sqlx_migrations 含む全テーブル DROP → CREATE → user_version 設定
}
```

- アクター起動時（setup 内・webview ロード前）に実行する。既存ユーザーは
  `user_version=0`（sqlx は設定しない）→ 初回起動で自動リビルド＝移行完了
- `reset_ghost_db` は「fs 削除」から「リビルドを実行する Reset ジョブ」へ格下げする。
  fs 削除と DB open の物理競合クラスが消え、JS の sqlx プール接続もテーブル再作成を
  透過的に生き延びる
- 起動時ガードとして「ファイルが open 不能（破損）なら fs 削除」だけの最小 sanitize を
  残す（webview 前なので競合なし）
- **user-data.db は現行のまま**（`ensure_schema` の追加式・絶対に DROP しない）
- **受け入れ済みトレードオフ**: スキーマを変えるリリースは全ユーザーのキャッシュ破棄＝
  初回フルスキャン。スキーマ変更は稀で、#134 の進捗 UI＋オフスレッド化が UX をカバー済み

## 5. JS の読み取り専用化

- `cleanupOldGhostCaches`（世代 5・TTL 30 日ポリシー、`ghostDatabase.ts:95-132`）→
  `CleanupCaches` ジョブへ移植。呼び出し元 `ghostCatalogService.ts:53`（cache miss 時のみ・
  fire-and-forget）は `invoke("cleanup_ghost_caches", ...)` に置き換える。
  ポリシーのユニットテスト（`ghostDatabase.test.ts` の 4 本）は Rust 側へ移植する
- `VACUUM`/`PRAGMA optimize`（`vacuumIfNeeded`・`loadDb`）→ アクター起動時の
  メンテナンス処理へ移動。JS `loadDb` は読み取りに必要な PRAGMA（busy_timeout）だけ残す
- `searchGhosts` 等の SELECT ホットパスは sqlx のまま**不変**（仮想スクロールの
  ページング性能に触れない）

## 6. 撤去されるもの

| 撤去対象 | 理由 |
|---|---|
| `ScanCoordinator`・`run_serialized`・poison 回復 | 排他が構造化され Mutex 自体が不要 |
| `lock_wiring.rs`・comctl32 manifest・`build.rs` link-arg・tauri `test` feature・`#[doc(hidden)] pub use`×4 | 配線のランタイム検証が不要（型が保証） |
| `<R: Runtime>` 総称化×4 関数 | ジョブが AppHandle 非依存 |
| sqlx migration 15 本＋`add_migrations` 登録 | スキーマが使い捨て |
| `sanitize_ghost_db`／`has_migration_conflict` | チェックサム衝突のバグクラス消滅（最小 sanitize に縮退） |
| JS `initializeDb` の migration 回復ロジック＋テスト | 同上 |
| 「ロックのメンバー」の 5 箇所ドキュメント同期 | writer 列挙が `Job` enum に一元化 |

## 7. フェーズ構成（単一 PR）

1. **Phase 1（使い捨てスキーマ）**: `ensure_cache_schema`＋sqlx migration 撤去＋
   reset の SQL リビルド化（ロック方式のまま）
2. **Phase 2（アクター）**: GhostDbActor 導入、scan/reset/record_launch をジョブ化、
   ScanCoordinator と lock_wiring 一式を撤去
3. **Phase 3（JS 読み取り専用化）**: cleanup のコマンド化・VACUUM のアクター移動

各フェーズでテスト先行。全フェーズ完了後に一括 PR（プロジェクト規約）。

## 8. リスクと対策

- **最大リスク**: `CACHE_SCHEMA` 1 枚と旧 migration 15 本の合成結果の一致。
  **対策**: Phase 1 に「旧 migration 全適用 DB と新 CREATE 文の `PRAGMA table_info`／
  インデックス一覧が完全一致する」比較テストを置き、切り替えを機械検証する。
  このテストは旧 `migrations()` をテスト専用コードとして残すことで成立させる
- **起動順序**: `ensure_cache_schema` は webview ロード前（setup 内）に同期実行し、
  JS の初回 SELECT が「テーブル不在」に遭遇しないことを保証する
- **IPC 契約**: scan_and_store／reset_ghost_db／record_launch の引数・戻り値は不変。
  新規コマンド `cleanup_ghost_caches` のみ追加（/ipc-check 対象）

## 9. テスト戦略

- アクター: 一時ファイル 2 つで構築する純ユニットテスト（並行ジョブ投入 → 直列実行の
  整合、panic ジョブ → アクター生存、Reset → リビルド後の user_version）
- スキーマ: 旧 migration 合成との完全一致テスト（§8）、user_version 不一致 → リビルド、
  一致 → 保持
- cleanup: JS の 4 テスト（世代上限・TTL・current 保護・全削除）を Rust へ移植
- JS: `ghostCatalogService.test.ts` のモック契約を `invoke` ベースへ更新。
  `initializeDb` 回復パスのテストは削除
