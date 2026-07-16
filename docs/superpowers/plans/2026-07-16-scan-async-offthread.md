# スキャンのメインスレッド解放（async オフスレッド化）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `scan_and_store`（と `reset_ghost_db`）をメインスレッドから逃がし、走査中も UI が応答するようにする。結果 payload は不変、scan は `Mutex` で直列化して lost update を防ぐ。

**Architecture:** `async fn` ＋ `tauri::async_runtime::spawn_blocking` で重い同期処理を別スレッドへ退避。managed state の `ScanCoordinator(Arc<Mutex<()>>)` を lock して scan-scan 間＋reset を直列化する。

**Tech Stack:** Rust / Tauri 2 / rusqlite / `std::sync::{Arc, Mutex}` / `tauri::async_runtime`。

## Global Constraints

- IPC の**引数・成功戻り値の型**（`ScanStoreResult`）は不変。フロントの**コード**変更なし。
- ロックは **scan-scan 間 ＋ reset** を直列化。**順序（要求順=反映順）は保証しない**。走査は**キャンセルしない**。
- `ScanCoordinator = Arc<Mutex<()>>`。poison は `lock().unwrap_or_else(|e| e.into_inner())` で回復。
- 既存 scan/delta の**結果 payload は不変**（現行本体を内部 `fn` へ移すだけ）。
- ロックの保護範囲は scan/reset のみ。`record_launch`（集計列/backfill）・`cleanupOldGhostCaches`（別 request_key）は
  SQLite WAL の writer 直列化＋`busy_timeout` に委ね、ロック対象にしない。
- 設計書: `docs/superpowers/specs/2026-07-16-scan-async-offthread-design.md`。

---

### Task 1: `ScanCoordinator` 型と managed state 登録

**Files:**
- Create: `src-tauri/src/scan_coordinator.rs`
- Modify: `src-tauri/src/lib.rs`（`mod` 宣言＋`.manage`）

**Interfaces:**
- Produces: `pub struct ScanCoordinator(pub std::sync::Arc<std::sync::Mutex<()>>)`（`Default` ＋ `Clone`）。
  `scan_and_store`（Task 2）・`reset_ghost_db`（Task 3）が `tauri::State<ScanCoordinator>` で受ける。

- [ ] **Step 1: 失敗するテストを書く**

`src-tauri/src/scan_coordinator.rs` に型と共にテストを置く（まだ型が無いので後述の実装で通す）:

```rust
#[cfg(test)]
mod tests {
    use super::ScanCoordinator;

    #[test]
    fn lock_を取得しpoisonから回復できる() {
        let c = ScanCoordinator::default();
        // 正常取得
        {
            let _g = c.0.lock().unwrap();
        }
        // poison させる（ロック保持中に panic）
        let c2 = c.clone();
        let _ = std::panic::catch_unwind(|| {
            let _g = c2.0.lock().unwrap();
            panic!("poison を発生させる");
        });
        // into_inner で回復して再取得できる
        let _g = c.0.lock().unwrap_or_else(|e| e.into_inner());
    }
}
```

- [ ] **Step 2: テストを実行し失敗を確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml scan_coordinator`
Expected: FAIL（`ScanCoordinator` が未定義でコンパイルエラー）

- [ ] **Step 3: 最小実装を書く**

`src-tauri/src/scan_coordinator.rs`:

```rust
use std::sync::{Arc, Mutex};

/// `scan_and_store` / `reset_ghost_db` を直列化する所有ロック。
/// `spawn_blocking` の `'static` クロージャへ move するため `Arc` で包む。
/// 中身は `()`（状態を持たない）ため poison しても `into_inner` で安全に回復できる。
#[derive(Default, Clone)]
pub struct ScanCoordinator(pub Arc<Mutex<()>>);
```

`src-tauri/src/lib.rs` の他の `mod` 宣言群の近くに追加:

```rust
mod scan_coordinator;
```

`src-tauri/src/lib.rs` の `tauri::Builder::default()` チェーン、`.setup(...)` の直前に追加（現 builder は
plugin/setup/invoke_handler のみで `.manage` は不在: `lib.rs:374-395`）:

```rust
        .manage(scan_coordinator::ScanCoordinator::default())
```

- [ ] **Step 4: テストを実行し成功を確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml scan_coordinator`
Expected: PASS（1 test）
Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/scan_coordinator.rs src-tauri/src/lib.rs
git commit -m "feat: scan 直列化用 ScanCoordinator を新設し managed state 登録"
```

---

### Task 2: `scan_and_store` の async 化とロック直列化

**Files:**
- Modify: `src-tauri/src/commands/ghost/mod.rs`（`scan_and_store` を async 化＋内部 `fn` 分離）
- Test: `src-tauri/src/commands/ghost/mod.rs`（tests モジュールに直列化整合テスト）

**Interfaces:**
- Consumes: `ScanCoordinator`（Task 1）、`apply_scan_delta`（既存 `mod.rs:131`）、
  `scan::scan_entries_with_fingerprint`（既存・本番経路）。
- Produces: `pub async fn scan_and_store(app, ssp_path, additional_folders, request_key, cached_fingerprint, coordinator: State<ScanCoordinator>) -> Result<ScanStoreResult, String>`、
  非 pub `fn scan_and_store_blocking(app: &AppHandle, ssp_path, additional_folders, request_key, cached_fingerprint) -> Result<ScanStoreResult, String>`。

- [ ] **Step 1: 失敗する直列化整合テストを書く**

`mod.rs` の `#[cfg(test)] mod tests` 内に、ファイル DB を開くヘルパーと並行整合テストを追加する。
ロック配下で異なる `entries` を並行に書いても、最終状態は常に**整合した 1 状態**（`ghosts` と `ghost_scan_entries`
が一致）に収束し、破損・パニックが起きないことを固定する（lost update = 破損の回帰ガード）:

```rust
/// migrations 適用済みのファイル ghosts DB を開く（並行テスト用・接続はスレッド毎に開く）。
fn open_file_ghost_db(path: &std::path::Path) -> rusqlite::Connection {
    let conn = rusqlite::Connection::open(path).unwrap();
    let mut sorted = crate::migrations();
    sorted.sort_by_key(|m| m.version);
    for m in &sorted {
        // 二度目の open では ghosts が既存のため migration をスキップ
        let already: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='ghosts'",
                [],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if already {
            break;
        }
        conn.execute_batch(m.sql).unwrap();
    }
    super::store::configure_connection(&conn).unwrap();
    conn
}

#[test]
fn scan_lock配下の並行deltaが整合状態を壊さない() {
    use crate::scan_coordinator::ScanCoordinator;
    use std::sync::{Arc, Barrier};
    use std::thread;

    // 2 つの ssp ツリー（片方は ghost_a、もう片方は ghost_b）を用意する。
    let tmp = TempDirGuard::new("scan_serialize");
    let ssp_a = tmp.path().join("ssp_a");
    let ssp_b = tmp.path().join("ssp_b");
    fs::create_dir_all(ssp_a.join("ghost")).unwrap();
    fs::create_dir_all(ssp_b.join("ghost")).unwrap();
    create_ghost_dir(&ssp_a.join("ghost"), "ghost_a").unwrap();
    create_ghost_dir(&ssp_b.join("ghost"), "ghost_b").unwrap();

    let db = tmp.path().join("ghosts.db");
    open_file_ghost_db(&db); // 初期化（テーブル作成）

    let coord = ScanCoordinator::default();
    let barrier = Arc::new(Barrier::new(2));

    // 同一 request_key "rk" に、異なる entries を並行に delta 適用する。
    let ssps = [ssp_a, ssp_b];
    let handles: Vec<_> = ssps
        .into_iter()
        .map(|ssp| {
            let coord = coord.clone();
            let barrier = barrier.clone();
            let db = db.clone();
            thread::spawn(move || {
                let ssp_str = ssp.to_string_lossy().to_string();
                let (entries, fp) =
                    super::scan::scan_entries_with_fingerprint(&ssp_str, &[]).unwrap();
                let conn = open_file_ghost_db(&db);
                barrier.wait(); // 両スレッドを同時に走らせる
                let _guard = coord.0.lock().unwrap_or_else(|e| e.into_inner());
                super::apply_scan_delta(&conn, "rk", &entries, &fp, "mtimes").unwrap();
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }

    // 直列化されているため、最終状態は「後に走った方の entries」に整合した 1 状態。
    // ghosts と ghost_scan_entries の件数が一致し（混合・破損なし）、1 件であること。
    let conn = open_file_ghost_db(&db);
    let ghosts: i64 = conn
        .query_row("SELECT COUNT(*) FROM ghosts WHERE request_key='rk'", [], |r| r.get(0))
        .unwrap();
    let entries: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM ghost_scan_entries WHERE request_key='rk'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(ghosts, 1, "直列化後は 1 体（後勝ちの entries）のはず");
    assert_eq!(ghosts, entries, "ghosts と scan_entries が整合しているはず");
}
```

- [ ] **Step 2: テストを実行し確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml scan_lock配下`
Expected: PASS（このテストは既存 `apply_scan_delta` ＋ Task 1 の `ScanCoordinator` で成立する。
直列化の正しさを**先に固定**しておき、次の async 化で壊さないことを保証する）。

- [ ] **Step 3: `scan_and_store` を async 化する**

`mod.rs` の現行 `scan_and_store`（`mod.rs:44-123`）を、コマンド薄殻＋内部関数へ分割する。
コマンドは `ScanCoordinator` の `Arc` を await 前に clone し、`spawn_blocking` 内で lock を取ってから内部関数を呼ぶ:

```rust
#[tauri::command]
pub async fn scan_and_store(
    app: tauri::AppHandle,
    ssp_path: String,
    additional_folders: Vec<String>,
    request_key: String,
    cached_fingerprint: Option<String>,
    coordinator: tauri::State<'_, crate::scan_coordinator::ScanCoordinator>,
) -> Result<ScanStoreResult, String> {
    // State は await をまたげないため Arc を先に取り出す。
    let lock = coordinator.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // scan-scan 間を直列化（lost update 防止）。poison は into_inner で回復。
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        scan_and_store_blocking(&app, ssp_path, additional_folders, request_key, cached_fingerprint)
    })
    .await
    .map_err(|e| format!("スキャンタスクの実行に失敗しました: {e}"))?
}

/// 現行 `scan_and_store` の同期本体（挙動不変）。`spawn_blocking` の別スレッドで実行される。
fn scan_and_store_blocking(
    app: &tauri::AppHandle,
    ssp_path: String,
    additional_folders: Vec<String>,
    request_key: String,
    cached_fingerprint: Option<String>,
) -> Result<ScanStoreResult, String> {
    // ← 現行 scan_and_store の本体（`ensure_request_key(&request_key)?;` から
    //    最後の `Ok(ScanStoreResult { ... })` まで）をそっくり移す。ロジックは一切変えない。
}
```

- [ ] **Step 4: 既存テスト green ＋ コンパイル確認**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: エラーなし（`State<'_, _>` のライフタイム・`spawn_blocking` の move が通る）
Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS（既存の scan/delta テスト＋Step 1 のテスト。結果 payload 不変）

- [ ] **Step 5: 手動 after 検証（メインスレッド非ブロック）**

`scan_and_store_blocking` の Layer 2 走査直前に一時的に `std::thread::sleep(std::time::Duration::from_secs(5));`
を注入し、`npm run tauri dev` で再読込する。走査中の 5 秒間に **検索入力・カードクリック・ウィンドウのドラッグ**が
応答すること（実証で凍った同経路が生きること）を目視確認する。**進捗バーのアニメでは判断しない**。
確認後、`git checkout -- src-tauri/src/commands/ghost/mod.rs` で診断 sleep を必ず revert する。

- [ ] **Step 6: コミット**

```bash
git add src-tauri/src/commands/ghost/mod.rs
git commit -m "perf: scan_and_store を async+spawn_blocking 化しメインスレッドを解放（#134）"
```

---

### Task 3: `reset_ghost_db` の async 化と排他

**Files:**
- Modify: `src-tauri/src/commands/db.rs`

**Interfaces:**
- Consumes: `ScanCoordinator`（Task 1）。
- Produces: `pub async fn reset_ghost_db(app_handle, coordinator: State<ScanCoordinator>) -> Result<(), String>`。

- [ ] **Step 1: 直列化の単体テストを書く**

`reset_ghost_db` は `AppHandle` 依存でコマンド直接テストが困難なため、**同一ロックが reset と scan を相互排他する**
ことを `ScanCoordinator` レベルで固定する。`db.rs` の `#[cfg(test)] mod tests` に追加:

```rust
#[cfg(test)]
mod tests {
    use crate::scan_coordinator::ScanCoordinator;
    use std::sync::{Arc, Barrier};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn 同一ロックがresetとscanを相互排他する() {
        let coord = ScanCoordinator::default();
        let held = Arc::new(AtomicBool::new(false));
        let overlap = Arc::new(AtomicBool::new(false));
        let barrier = Arc::new(Barrier::new(2));

        // scan 役: ロックを保持している間フラグを立てる。
        let c1 = coord.clone();
        let held1 = held.clone();
        let b1 = barrier.clone();
        let scan = thread::spawn(move || {
            b1.wait();
            let _g = c1.0.lock().unwrap_or_else(|e| e.into_inner());
            held1.store(true, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(50));
            held1.store(false, Ordering::SeqCst);
        });

        // reset 役: ロック取得時に scan がロック保持中でないことを確認する。
        let c2 = coord.clone();
        let held2 = held.clone();
        let overlap2 = overlap.clone();
        let b2 = barrier.clone();
        let reset = thread::spawn(move || {
            b2.wait();
            thread::sleep(Duration::from_millis(10)); // scan に先にロックを取らせる
            let _g = c2.0.lock().unwrap_or_else(|e| e.into_inner());
            if held2.load(Ordering::SeqCst) {
                overlap2.store(true, Ordering::SeqCst);
            }
        });

        scan.join().unwrap();
        reset.join().unwrap();
        assert!(!overlap.load(Ordering::SeqCst), "reset と scan が同時にロックを保持してはならない");
    }
}
```

- [ ] **Step 2: テストを実行し確認**

Run: `cargo test --manifest-path src-tauri/Cargo.toml 同一ロックがresetとscan`
Expected: PASS（`Mutex` の相互排他により `overlap` は立たない）

- [ ] **Step 3: `reset_ghost_db` を async 化＋lock する**

`src-tauri/src/commands/db.rs` の現行 `reset_ghost_db`（`db.rs:4-16`）を置き換える:

```rust
use crate::db_path;

/// ghosts.db と関連ファイル（WAL/SHM）を削除してマイグレーション競合を解消する。
/// scan と同じ ScanCoordinator ロックを取り、走査中の削除（DB open/write 失敗）を防ぐ。
/// 別スレッド実行のためメインスレッドはロック待ちで固まらない。
#[tauri::command]
pub async fn reset_ghost_db(
    app_handle: tauri::AppHandle,
    coordinator: tauri::State<'_, crate::scan_coordinator::ScanCoordinator>,
) -> Result<(), String> {
    let lock = coordinator.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        let db_dir = db_path::ghost_db_dir(&app_handle)?;
        for filename in db_path::GHOST_DB_FILES {
            let path = db_dir.join(filename);
            if path.exists() {
                std::fs::remove_file(&path).map_err(|e| format!("{filename} の削除に失敗: {e}"))?;
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("DB リセットタスクの実行に失敗しました: {e}"))?
}
```

- [ ] **Step 4: コンパイル・テスト確認**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: エラーなし（`reset_ghost_db` は `lib.rs:389` の invoke_handler に登録済み。`State` 注入は自動）
Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS（全テスト）

- [ ] **Step 5: 全体検証**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path crates/ghost-meta/Cargo.toml --features thumbnail,serde
npm run build
npm test
```
Expected: すべて green。IPC の引数・成功戻り値の型は不変のため生成型（`src/types/generated/`）は変化しない
（`cargo test` 後に `git status --porcelain src/types/generated/` が空であることを確認）。

- [ ] **Step 6: コミット**

```bash
git add src-tauri/src/commands/db.rs
git commit -m "fix: reset_ghost_db を async 化し scan と同一ロックで排他（#134）"
```

---

## Self-Review

- **Spec coverage**:
  - §3 A（async fn + spawn_blocking）→ Task 2 Step 3。
  - §3 所有権（State→Arc clone）→ Task 1（型）＋ Task 2 Step 3（clone して move）。
  - §4 lost update / scan-scan 直列化 → Task 2 Step 1（整合テスト）＋ Step 3（lock）。
  - §4 順序非保証・キャンセル契約・他 writer 独立 → Global Constraints に明記（コード変更を伴わない契約）。
  - §5 `.manage` 追加 → Task 1 Step 3。
  - §6 poison 回復 → Task 1（テスト）＋ Task 2/3（`unwrap_or_else(into_inner)`）。
  - §6 reset 排他 → Task 3。
  - §7 並行テスト・cargo check・手動 after 検証・生成型不変 → Task 2 Step 1/4/5、Task 3 Step 4/5。
  - 非スコープ（walk 削減・cold リグ・progress streaming）→ タスク化しない（意図的除外）。
- **Placeholder scan**: 各 code step に実コードを記載。Task 2 Step 3 の内部関数は「現行本体をそっくり移す」と
  明示（現行コードは `mod.rs:52-116` に実在。移動のみで新規記述なし）。
- **Type consistency**: `ScanCoordinator(Arc<Mutex<()>>)`（Task 1）と `coordinator.0.clone()`（Task 2/3）一致。
  `apply_scan_delta(conn, request_key, entries, fingerprint, parent_mtimes)`（Task 2 テスト）は既存シグネチャ
  （`mod.rs:131`）と一致。`scan_and_store_blocking` の引数（Task 2 Step 3）はコマンドの move 変数と一致。
