# src-tauri/ — バックエンド作業規約

## テストパターン

**Rust テストの一時ディレクトリ**: テスト用の一時ディレクトリは `TempDirGuard` パターンで管理し、テスト終了時に確実に削除します。

**依存クレートの移行・更新**: シリアライズ形式やストレージ形式に関わるクレートを移行する場合は、必ず後方互換性を検証する。(1) 移行前の形式で保存されたデータを移行後のコードで読めるか確認する。(2) フォールバックパス（旧形式 → 新形式への自動変換）が必要か判断する。(3) クレートのバージョンアップ時は `cargo info <crate>` でダウンロード数・リポジトリ URL・最終公開日を確認し、トロルパッケージやプレースホルダーでないことを検証する。

## SQLite

> マイグレーション関連のミスはアプリ起動不能につながる。以下を必ず守る。

**使い捨てスキーマ（`cache_schema.rs`）**: ghosts.db はマイグレーションを持たない。`CACHE_SCHEMA`（`src-tauri/src/cache_schema.rs`）が単一権威の定数文字列で、そのハッシュ（FNV-1a）を `PRAGMA user_version` に刻む。起動時に `ensure_cache_schema` が現在の `user_version` とハッシュを比較し、不一致（＝スキーマ本文の変更）なら単一トランザクションで全テーブルを DROP+CREATE して作り直す。手動 bump が存在しないため「bump 忘れで既存ユーザーだけ壊れる」クラスが構造的に存在しない。**スキーマを変更したら `CACHE_SCHEMA` を直接編集してよい**（かつての追記式マイグレーションのような不変性の制約はない）。変更すれば次回起動で全ユーザーのキャッシュが自動リビルドされ、フルスキャンで再投入される（受容済みトレードオフ）。旧 sqlx migration 群との parity テストと `lib.rs` の `migrations()` は、初のスキーマ変更（#136 Phase 2）で役目を終え削除済み。検索派生列 `search_text` は `CACHE_SCHEMA` 内の**生成列**（導出式がスキーマ定数の単一権威・書込側は関与しない）。user-data.db（永続）はこの機構の対象外（`launch_history::ensure_schema` の追加式のみ）。

**DB 初期化 PRAGMA**: JS `loadDb()` は `busy_timeout` のみを設定する読み取り専用スコープ。`journal_mode=WAL`／`journal_size_limit` は rusqlite 書き込み接続の `configure_connection` が設定し、`PRAGMA optimize`／条件付き VACUUM は DB アクターの `Job::Maintenance`（起動直後の自己投入ジョブ・失敗してもログのみで続行）が担う。詳細は `SPEC.md` §8.1.1 を参照。

**単一 writer アクター（`actor/`）＋ rusqlite 直接書き込み**: ghosts.db/user-data.db への全書き込みは `actor::spawn_actor` が起動する専有スレッドのみが行う。`Job` enum（`actor/mod.rs`: `Scan`/`RecordLaunch`/`CleanupCaches`/`Maintenance`）を mpsc（unbounded）で受信して逐次実行し、結果は oneshot で呼び出し元へ返す。コマンド層（`scan_and_store`・`record_launch`・`cleanup_ghost_caches`）は Job を送るだけの薄い皮で、DB 接続を持たない。**構造的封鎖**: ghosts.db のパス解決（`actor::db_path`）はアクターモジュール専有可視性に落としてあり、コマンド層からはパス解決自体が不可能。加えて `clippy.toml` の `disallowed-methods` で actor モジュール外の `rusqlite::Connection::open` を lint 禁止する（保険。テストは `#[allow(clippy::disallowed_methods)]` を付ける）。ジョブ内の panic は `catch_unwind` で隔離してエラー応答へ変換し、アクタースレッド自体は生存し続ける（Mutex poison 回復の後継。詳細は設計書 §2.3/§3.1）。アクター内部の書き込みは `tauri-plugin-sql`（sqlx）を経由せず rusqlite で直接 SQLite に書き込む。rusqlite の接続は sqlx 側の PRAGMA を継承しないため、`configure_connection` で独立して PRAGMA を設定する（WAL・busy_timeout・synchronous=NORMAL・cache_size・temp_store・mmap_size）。`rusqlite::Connection::execute_batch` は `sqlite3_exec` を使用するため、セミコロン区切りの複数文を正しく実行できる（sqlx の `sqlite3_prepare_v2` とは異なる）。`request_key` はフロントエンドが単一権威として計算し、`scan_and_store` は値で受け取る。Rust 側で再計算しない（不透明トークンとして扱う）。

**cross-DB JOIN は不可（sqlx プールで ATTACH が揮発）**: `tauri-plugin-sql`（sqlx）の `Database.load` は `Pool::connect` で接続を都度取得する（`select`/`execute` が毎回 `pool.fetch_all`/`pool.execute`）。このため `db.execute("ATTACH …")` と後続の JOIN クエリが別接続に載り **ATTACH が揮発**し、JS/sqlx 経路で複数 DB ファイルをまたぐ JOIN は成立しない。永続テーブル `ghost_launches` を Rust 専有の `user-data.db`（`commands/launch_history.rs`、rusqlite 単一接続なので ATTACH 安全）へ分離したのはこの制約が理由。読み取り側は `ghosts` の非正規化集計列 `last_launched`/`launch_count`（`record_launch` 即時更新＋スキャン時 backfill 再導出）で recent/frequency を単一 DB ORDER BY にする。クロス DB 集計が要る場合は JS/sqlx の ATTACH に頼らず、Rust 単一接続で ATTACH するか非正規化列を使う。詳細は `SPEC.md` §4.5/§6.5 を参照。

**store_ghosts_delta の差分書込（delta）**: Layer 2 ミス時は `scan_entries_with_fingerprint`（parse なしの file_type walk）で全子の走査エントリ（`scan_key`・`token`・`ghost_identity_key`）と fingerprint を得て、前回の `ghost_scan_entries`（`scan_key -> token`）と比較し、**変化した子だけを再 parse** して `store_ghosts_delta` で書き込む（1 体増減で 10 万体を再 parse しない）。`store_ghosts_delta` は `ON CONFLICT(request_key, ghost_identity_key) DO UPDATE … WHERE row_fingerprint 相違` で INSERT/UPDATE/no-op を分岐（不変メタは updated_at を bump しない）、削除子・parse 失敗子は DELETE、`ghost_scan_entries`・fingerprint・parent_mtimes を同一トランザクションで更新する。`total` は `SELECT COUNT(*)` を返し、集計列 `last_launched`/`launch_count` は不可侵（commit 後に backfill）。`scan_key` は生の物理キー（NFKC 畳み込みを避けサイレント消失を防ぐ）、`ghost_identity_key`（NFKC(source)+`\x1f`+NFKC(dir_name)）は `ghost_identity_key(source, directory_name)` が単一権威。delta は不変子をスキップするため DB 側 UNIQUE の loud 衝突検知が働かない → 書込前に走査エントリ上で `check_identity_uniqueness` を単一権威として通す。前回 `ghost_scan_entries` が空の初回/移行時は既存 ghosts を読み、走査に現れない取り残し identity を set-difference で DELETE する。`walk_parent`/`scan_ghosts_with_fingerprint_internal`（全 parse walk）は `#[cfg(any(test, feature="bench"))]` で本番非コンパイル（parity 参照・full_scan 計測専用）。

**永続テーブルのマイグレーション**: `ghost_launches` や将来の `favorites` 等の永続テーブル（ユーザー蓄積データ）は、揮発キャッシュの `ghosts`（使い捨てスキーマ・スキーマ変更で自動的に全件破棄・再投入される）と異なり、**スキーマ変更時に全件 DROP/DELETE してはならない**。破壊的スキーマ変更はデータ移行 SQL を必須とし、段階移行（新列追加 → バックフィル → 参照切替）で行う。ゴーストへの外部参照は `ghosts.id`（再投入で値が変わる）ではなく `ghost_identity_key` を使う。起動履歴は現在 `user-data.db` へ分離済み。将来の `favorites` 等の永続テーブルも user-data.db 側へ置き、揮発キャッシュ ghosts.db との運命共有を避ける。データモデルの根拠とキー構成は `SPEC.md` §4.5 を参照。

## IPC 型の管理

**ts-rs による自動生成**: IPC 境界を越える Rust struct には `#[cfg_attr(test, derive(TS))]` + `#[cfg_attr(test, ts(export))]` を付与する。`cargo test` 実行時に `src/types/generated/` へ TypeScript 型定義が自動生成される。手書きで TS 型を定義しない。

**戻り値のフィールド名**: Tauri の `invoke()` は引数名を camelCase → snake_case に自動変換するが、**戻り値のフィールド名は変換しない**。`#[derive(Serialize)]` がそのまま JS に渡るため、TS 型は Rust のフィールド名（snake_case）と完全一致させる。`#[serde(rename_all = "camelCase")]` を使わない限り、JS 側で camelCase を期待してはならない。

## その他

**rusqlite と sqlx-sqlite の libsqlite3-sys 共有制約**: `rusqlite` と `sqlx-sqlite`（`tauri-plugin-sql` 経由）は両方とも `links = "sqlite3"` を宣言するため、`libsqlite3-sys` を必ず同一バージョンで共有しなければならない（cargo の links 制約）。`tauri-plugin-sql` 2.4.0 系は `sqlx-sqlite 0.8.x`（libsqlite3-sys ^0.30）に固定されているため、`rusqlite` の上限は **0.32**（libsqlite3-sys 0.30）。`rusqlite` の major bump は `tauri-plugin-sql` が新 `sqlx`（libsqlite3-sys 0.37+）系に追従するまで待機する。**解錠条件**: `sqlx-sqlite 0.9` は libsqlite3-sys 要求を `>=0.30.1, <0.38.0` へ拡大したため、`tauri-plugin-sql` が `sqlx 0.9` 対応版を公開した時点で `rusqlite` は **0.39**（libsqlite3-sys 0.37）まで引き上げ可能になる（0.40 は libsqlite3-sys 0.38 要求で依然不可）。2026-06 時点で sqlx 0.9 対応の `tauri-plugin-sql` は未公開。

**descript.txt 文字コード判定**: UTF-8 BOM → `charset` フィールド → Shift_JIS フォールバックの順で判定します（`crates/ghost-meta/src/descript.rs`）。

**ファイルシステム操作の OS 差異**: macOS と Windows の挙動差に注意。`entry.metadata()` は Windows FindNextFile キャッシュを参照し陳腐化する場合がある。`fs::metadata(path)` は常に最新値を返す。
