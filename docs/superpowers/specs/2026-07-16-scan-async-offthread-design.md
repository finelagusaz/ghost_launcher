# 設計書: スキャンのメインスレッド解放（async オフスレッド化）

- 日付: 2026-07-16
- 関連: issue #134 Phase 3（非ブロッキング化）の**本体**。#144（進捗バー・軽量版）が前提とした
  「走査はバックグラウンドで走る」を実際に成立させる、欠けていた構造ピース。
- 種別: バックエンド（Rust）中心。IPC の**引数・成功戻り値の型**は不変（フロントの**コード**変更は不要）。
- 改訂: Codex 非対話レビュー（2026-07-16・session 019f69c6）の指摘を反映（並行性・所有権・DB writer 境界）。

## 1. 問題

`scan_and_store` は同期 `#[tauri::command] pub fn`（`commands/ghost/mod.rs:44`）である。Tauri 公式モデルでは
**同期コマンドはメインスレッドで実行**され（async コマンドのみ `async_runtime::spawn` で別スレッド）、その間
WebView の UI スレッドが塞がる。

実証（2026-07-16）: Layer 2 走査直前に `std::thread::sleep(5s)` を一時注入し `tauri dev` で再読込したところ、
その 5 秒間**検索ボックスへの入力が不可**になり、**ウィンドウが「応答なし」（半透明の白）**へ落ちた。cold walk 中は
UI が固まる——アプローチ2 の受け入れ基準「**走査中に UI がブロックしない**」は未達である。

#144 が出荷した進捗バー＋stale-while-revalidate は「走査がバックグラウンドで進む」ことを暗黙の前提にしていた。
だが同期・メインスレッド実行ではその前提が偽で、しかも進捗バーの CSS アニメは WebView2 の別プロセスで回るため、
**メインスレッドが凍っていてもバーは回り「動いているフリ」をする**（実証で確認）。

本設計が解くのは「walk が遅い」ではなく「**同期ゆえメインスレッドを塞ぐ**」という構造問題である。狙いは走査を
速くすることではなく、規模に依らずその構造そのものを除くこと——(i) 大規模コレクションでの実フリーズ解消、
(ii) #144 が前提したバックグラウンド走査の成立、(iii) 並行実行の安全網（現在は同期直列化に暗黙依存）の是正——にある。

## 2. スコープ / 非スコープ

- **スコープ**: `scan_and_store` をメインスレッドから逃がし、走査中も UI（検索・クリック・ウィンドウ操作）の応答を
  保つ。scan の**結果 payload**は不変。async 化で失われる直列実行を補う**scan-scan 間の並行ガード**を含む。
- **非スコープ**:
  - **walk コスト自体の削減**（FS 変更通知・インクリメンタル走査）。現実規模（数百〜数千体）では file_type walk は
    数十 ms（計測: 約 9ms/1k 体）、cold でも 100ms 未満で、async 化すれば stale 窓は知覚不可。**多秒フリーズは
    10 万体合成計測でのみ生じる幻**。→ 将来の別 issue に申し送る。
  - **進捗の確定表示（X/N・streaming イベント）**。非確定バー（#144）で足りる。
  - **cold-cache 定量計測リグ**。受け入れ基準の判定には不要（async で解決）。
  - **走査のキャンセル／FIFO 順序保証**。リクエスト切断・古い要求の UI 無効化は進行中の走査を止めない（§4 の契約）。
    スキャン発火は有界（`auto` は effect・`force` はボタン）ゆえ `CancellationToken` や専用キューは導入しない（YAGNI）。

## 3. 採用アプローチ

**A: `async fn` ＋ `spawn_blocking`。**

- `scan_and_store` を `async fn` に変更する。現行の同期ロジックは**そのまま**内部関数 `scan_and_store_blocking`
  （非 pub）へ移す（結果 payload はゼロ変化。ただし DB 操作の並行性・完了順は変わる——§4）。
- コマンド本体は `tauri::async_runtime::spawn_blocking(move || scan_and_store_blocking(...))` を `.await` するだけ。
  `JoinHandle` を await した結果の `JoinError` は `String` エラーへ変換する。
- **所有権（重要）**: `spawn_blocking` のクロージャは `Send + 'static` を要求するため、借用型 `tauri::State`
  はそのまま move できない。直列化ロックは **`Arc<std::sync::Mutex<()>>` を包む所有型**（`ScanCoordinator`）を
  managed state に持ち、コマンドで `state.inner().0.clone()`（`Arc` の clone）を得て closure へ move する。
  他の引数（`ssp_path: String` / `additional_folders: Vec<String>` / `request_key: String` /
  `cached_fingerprint: Option<String>` / `app: AppHandle`）はすべて `Send + 'static` ゆえ素直に move。

代替案と不採用理由:
- **B（`async fn` のみ・内部は同期のまま）**: メインスレッドは解放されるが、重い rayon walk が tokio ワーカースレッドを
  長時間専有し他の async 処理を飢えさせる。ブロッキング処理は `spawn_blocking` へ逃がすのが tokio の正道。
- **C（イベント駆動・開始即返す＋完了 emit）**: IPC 契約とフロントの呼び出し規約が変わり波及が大きい。非確定バーで
  足りる現状には過剰（YAGNI）。

## 4. 並行性（本設計の核心）

同期・メインスレッド実行は、scan を**暗黙に直列化**していた（2 つ目は 1 つ目の完了を待つ）。async 化はこの安全網を
外すため、直列化を明示的に補わねばならない。

- **フロントガードの限界**: `useGhosts` の `inFlightKeyRef` は集合ではなく**単一の ref**で、**直前の in-flight 1 件と
  完全一致するときだけ**弾く（`useGhosts.ts:12,28-32`）。`auto`（起動時自動）と `force`（再読込）は別キーゆえ並行し、
  `auto → force → auto` のようにキーが替わると最初と同キーの 3 件目も通る。発火頻度自体は有界（effect＋ボタン）。
- **lost update（確認済み）**: `apply_scan_delta` は前回状態を**トランザクション外**で読み（`mod.rs:142`
  `read_scan_entries`）、書き込みは後段の `store_ghosts_delta`（`mod.rs:230`）で初めてトランザクション化される。
  2 つの scan が同じ `prev` から別々の差分を計算すると、後勝ちで一方の差分が消える。
- **対策**: `ScanCoordinator` の `Mutex<()>` を `scan_and_store_blocking` の冒頭で lock し **scan-scan 間を直列化**する。
  lock 待ちは `spawn_blocking` スレッドで起きるため、**メインスレッドは待たない**。
- **保証すること / しないこと**:
  - **する**: 直列化により lost update を防ぐ。全要求は取りこぼさず順に完走する。
  - **しない**: **要求順＝反映順**の保証（`std::sync::Mutex` に FIFO/公平性はない。後発 force が先に走る等あり得る）。
    ただし各 scan はロック取得後に**現在の FS**を読むため、最終 DB 状態はどの scan が最後でも「現在の FS の反映」に
    収束し、順序非依存で実害はない（2 scan 間で FS が変わる稀なケースの一過性のみ）。順序保証が要件化したら
    dedicated scan queue / 世代番号 coordinator を別途検討（現状 YAGNI）。
- **ロックの保護範囲は scan-scan 間 ＋ reset（§6）＋ record_launch**（後二者は実装で確定・当初設計の訂正）。
  同じ ghosts.db の他 writer との関係:
  - `record_launch`（`launch_history.rs`）は**同一ロックで直列化**する（レビュー指摘による訂正）。当初は
    「集計列のみ更新＋`store_ghosts_delta` は集計列不可侵ゆえ論理的に独立」と判断したが、scan 側の backfill は
    「user-data SELECT → ghosts へ**絶対値** UPDATE」の read-modify-write であり、その間に record_launch の
    **相対** bump（+1）が割り込むと集計が古い絶対値で巻き戻る lost update が成立する（WAL の文単位直列化では
    防げない）。record_launch も async + `spawn_blocking` 化してロックを取る。
  - `cleanupOldGhostCaches`（`ghostDatabase.ts:123-129`）は**別 request_key** を削除（現 request_key は keep）ゆえ
    scan 対象行と**非交差**。
  - いずれも物理的には SQLite WAL の writer 直列化＋`busy_timeout` で守られる（破損しない）。
  - `reset_ghost_db`（`db.rs:4-16`）は**例外**——DB/WAL/SHM を fs 削除するため scan と物理衝突しうる（§6）。
- **キャンセル契約**: リクエスト切断・古い要求の UI 無効化（`useGhosts` の `requestSeqRef` は UI state 更新のみ抑止・
  `useGhosts.ts:48-58`）は**進行中の走査を止めない**。走査は必ず完走し DB へ反映される。発火が有界ゆえ
  `spawn_blocking` 待ちは無制限に積まない。

## 5. 変更点（コンポーネント）

- **`commands/ghost/mod.rs`**: `scan_and_store` を `async fn` 化。現行本体を内部 `fn scan_and_store_blocking` へ移動。
  コマンドは `ScanCoordinator` の `Arc` を clone し、`spawn_blocking` で内部関数を駆動する。
- **直列化ロック**: `struct ScanCoordinator(std::sync::Arc<std::sync::Mutex<()>>)`（`Default` 実装）を新設し、
  `lib.rs` の builder に **`.manage(ScanCoordinator::default())` を追加**する（現 builder は plugin/setup/invoke_handler
  のみで `.manage` は不在: `lib.rs:374-395`）。コマンドは `coordinator: tauri::State<ScanCoordinator>` を受け、Arc を clone。
- **無変更**: IPC の引数・成功戻り値（`ScanStoreResult`）・`src/types/generated/`・フロントの**コード**
  （`useGhosts`/`ghostCatalogService`）・既存テストのモック契約。`async fn` でも `invoke("scan_and_store", …)` の
  呼び出し規約は同一。

## 6. エラーハンドリング

- `spawn_blocking` の `JoinError`（内部 panic 等）→ `"スキャンタスクの実行に失敗しました: {e}"` の `Err(String)`。
  既存の scan エラーも `Err(String)` ゆえフロントの `buildScanErrorMessage` はコード変更なく扱えるが、これは
  **新しいエラー発生源**であり観測可能な変化として扱う（§7 の並行テストで固定）。
- **Mutex poison**: `Mutex<()>` は状態を持たないため `into_inner` で回復する（silent 回復）。走査 panic 自体は
  `JoinError`→`Err(String)` として frontend に surface されるため無音ではない。コードベースに構造化ログ基盤が無い
  （`lib.rs` に ad-hoc `eprintln!` が 1 箇所のみ）ため、回復経路のサーバ側記録は設けない。`store_ghosts_delta` は
  トランザクション化ゆえ panic 時も中途書込は残らず、次 scan は ghosts.db を再オープンして正常実行できる。
- **reset との競合**: async 化後、scan（別スレッド）実行中に `reset_ghost_db`（メインスレッド同期コマンド）が走りうる。
  reset は稀（`getDb` のマイグレーション失敗自動回復時: `src/CLAUDE.md`）だが、scan の DB open/write を失敗させうる。
  方針: **reset も `ScanCoordinator` の lock を取り** scan と直列化する（実装計画で確定）。最低限、scan 側の DB エラーは
  既存の `Err(String)` 経路で穏当に返す。
- 既存のエラー経路（`request_key` 空・DB オープン失敗・identity 衝突など）は内部関数内でそのまま維持。

## 7. テスト / 検証

- **結果 payload 不変の担保**: 既存の scan/delta テスト（`apply_scan_delta`・store 系・`cargo test`）green を維持する。
- **並行ガード（テスト先行）**: 直列化ロック配下で `scan_and_store_blocking` 相当を 2 スレッドから同時に走らせ、
  ghosts.db の件数・identity が整合する（lost update が起きない）ことを固定する。ロック不在では壊れ、導入で通る形。
- **他 writer 同時実行**: `cleanup`×scan（別 request_key で破損しない）、`reset`×scan（排他またはエラー穏当返却）を確認。
- **フロント並行リクエスト**: `useGhosts` の `auto`×`force` 重畳テストで、非同期化後も loading/error 遷移が壊れないこと。
- **ビルド**: `.manage` 追加後の `cargo check`（`State` 注入のコンパイル確認）を必須にする。`cargo test` /
  `npm test` / `npm run build` green。
- **メインスレッド非ブロック（手動 after 検証・`/verify`）**: 診断 sleep もしくは実 walk を発火し、走査中に検索入力・
  カードクリック・ウィンドウ移動が応答することを目視確認する（実証で凍った同経路が生きることの確認）。
- **観点**: IPC の引数・成功戻り値の型は不変ゆえ `/ipc-check` は非該当。並行・ロック・DB writer 境界に触れるため
  `/cache-check` の観点で整合を確認する。

## 8. スコープ境界・申し送り

- FS 変更通知によるインクリメンタル走査（walk 根絶）は現実規模で利得が無く、別 issue とする。
- cold-cache 定量計測リグは作らない（受け入れ基準は async 化で満たされる）。
- 順序保証・キャンセルが将来要件化したら dedicated scan queue / 世代番号 coordinator を検討（現状 YAGNI）。
