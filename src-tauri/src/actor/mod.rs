//! ghosts.db への全書き込みを直列化する単一 writer アクター（設計書 §2/§3）。
//! Connection はこのスレッドだけが所有する。排他は「消費者が 1 人のキュー」という構造
//! そのものであり、Mutex もロック配線テストも存在しない。
//!
//! `bootstrap` が起動配線（設計書 §2.1）を担い、`.manage(ActorHandle)` するのは
//! lib.rs の setup。ghosts.db のパス解決（db_path）はこのモジュール専有（設計書 §2.3）。

mod db_path;

use rusqlite::Connection;
use std::panic::{catch_unwind, AssertUnwindSafe};
use tokio::sync::{mpsc, oneshot};

/// 起動配線（設計書 §2.1 の 5 ステップ・すべて setup スレッドで同期実行）。
/// 順序は不変条件: sanitize → user-data 初期化＋legacy 移送 → スキーマ確定 → スレッド起動。
/// 特に「移送 → ensure_cache_schema」の順序を破ると、旧世代 DB の永続履歴が
/// リビルドの全 DROP に巻き込まれて失われる（issue #93/#146）。
// bootstrap は actor 起動配線として ghosts.db/user-data.db を直接開く正当な唯一の入口（設計書 §2.3）。
#[allow(clippy::disallowed_methods)]
pub(crate) fn bootstrap(app: &tauri::App) -> Result<ActorHandle, String> {
    // (1) パス解決（単一権威・ここ以外に ghosts.db のパスを知るコードは存在しない）と最小 sanitize
    let db_dir = db_path::ghost_db_dir(app)?;
    let ghosts_path = db_dir.join(db_path::GHOST_DB_FILES[0]);
    sanitize(&db_dir, &ghosts_path);

    // (2) user-data 初期化 + legacy 移送
    let user_path = db_path::user_data_db_path(app)?;
    let user_conn = rusqlite::Connection::open(&user_path)
        .map_err(|e| format!("user-data.db オープンエラー: {e}"))?;
    crate::commands::ghost::store::configure_connection(&user_conn)
        .map_err(|e| format!("user-data.db の{e}"))?;
    crate::commands::launch_history::ensure_schema(&user_conn)?;
    if ghosts_path.exists() {
        if let Ok(g) = rusqlite::Connection::open(&ghosts_path) {
            let _ = crate::commands::launch_history::migrate_legacy_launch_history(&g, &user_conn);
        }
    }

    // (3) ghosts を開きスキーマ確定（webview ロード前なので初回 SELECT は必ず確定後）。
    //     失敗時は fs 削除リトライ 1 回（cache_schema::open_with_recovery と同一の回復）。
    let ghosts_conn = crate::cache_schema::open_with_recovery(&ghosts_path)?;

    // (4) 所有権 move でスレッド起動
    Ok(spawn_actor(ghosts_conn, user_conn))
}

/// ghosts.db が破損して open 不能なら関連ファイルごと削除する（webview ロード前なので競合なし）。
// bootstrap 内の破損検知専用の正当な open（設計書 §2.3）。
#[allow(clippy::disallowed_methods)]
fn sanitize(db_dir: &std::path::Path, ghosts_path: &std::path::Path) {
    if !ghosts_path.exists() {
        return;
    }
    let ok = rusqlite::Connection::open(ghosts_path)
        .and_then(|c| c.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0)))
        .is_ok();
    if !ok {
        for filename in db_path::GHOST_DB_FILES {
            let _ = std::fs::remove_file(db_dir.join(filename));
        }
    }
}

/// ghosts.db への書き込みの全種類（設計書 §3）。新しい writer は必ずここに variant を足す。
pub(crate) enum Job {
    RecordLaunch {
        ghost_identity_key: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Scan {
        ssp_path: String,
        additional_folders: Vec<String>,
        request_key: String,
        cached_fingerprint: Option<String>,
        reply: oneshot::Sender<Result<crate::commands::ghost::ScanStoreResult, String>>,
    },
    /// テスト専用: run_guarded の panic 隔離・接続健全性を検証するための故意 panic。
    #[cfg(test)]
    PanicForTest { reply: oneshot::Sender<Result<(), String>> },
}

/// アクターへの送信ハンドル。`.manage()` で全コマンドに配られる。
#[derive(Clone)]
pub(crate) struct ActorHandle {
    tx: mpsc::UnboundedSender<Job>,
    #[cfg(test)]
    thread: std::sync::Arc<std::sync::Mutex<Option<std::thread::JoinHandle<()>>>>,
}

impl ActorHandle {
    /// 送信は非ブロッキング（unbounded）。アクター停止後はエラー文字列に写像する（panic しない）。
    pub(crate) fn send(&self, job: Job) -> Result<(), String> {
        self.tx.send(job).map_err(|_| "DB アクターが停止しています".to_string())
    }

    #[cfg(test)]
    pub(crate) fn thread_handle_for_test(&self) -> std::thread::JoinHandle<()> {
        self.thread.lock().unwrap().take().expect("thread handle は 1 回だけ取得できる")
    }
}

/// 所有権を move してアクタースレッドを起動する。呼び出し側（bootstrap／テスト）は
/// スキーマ確定済みの Connection を渡すこと。
pub(crate) fn spawn_actor(ghosts_conn: Connection, user_conn: Connection) -> ActorHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    // Task 7 配線までは非テストビルドで JoinHandle を保持しない（detach）ため _ 接頭辞。
    let _thread = std::thread::Builder::new()
        .name("ghost-db-actor".to_string())
        .spawn(move || run_loop(ghosts_conn, user_conn, rx))
        .expect("DB アクタースレッドの起動に失敗");
    ActorHandle {
        tx,
        #[cfg(test)]
        thread: std::sync::Arc::new(std::sync::Mutex::new(Some(_thread))),
    }
}

/// 受信ループ。チャネルクローズ（全 Sender drop）で終了する（設計書 §2.2）。
/// ループ本体は panic フリーに保つ（ジョブ内の panic は run_guarded が隔離する）。
fn run_loop(mut ghosts_conn: Connection, user_conn: Connection, mut rx: mpsc::UnboundedReceiver<Job>) {
    while let Some(job) = rx.blocking_recv() {
        handle_job(&mut ghosts_conn, &user_conn, job);
    }
}

fn handle_job(ghosts: &mut Connection, user: &Connection, job: Job) {
    match job {
        Job::RecordLaunch { ghost_identity_key, reply } => {
            let result = run_guarded(ghosts, |g| {
                crate::commands::launch_history::record_launch_inner(user, g, &ghost_identity_key)
            });
            let _ = reply.send(result); // reply drop（呼び出し側キャンセル）は無視。ジョブは完走済み
        }
        Job::Scan { ssp_path, additional_folders, request_key, cached_fingerprint, reply } => {
            let result = run_guarded(ghosts, |g| {
                crate::commands::ghost::scan_and_store_blocking(
                    g, user, ssp_path, additional_folders, request_key, cached_fingerprint,
                )
            });
            let _ = reply.send(result);
        }
        #[cfg(test)]
        Job::PanicForTest { reply } => {
            let result = run_guarded(ghosts, |_| -> Result<(), String> { panic!("テスト用 panic") });
            let _ = reply.send(result);
        }
    }
}

/// DB 作業を panic から隔離して実行する（Mutex poison 回復の後継・設計書 §3.1）。
/// panic はエラー応答へ変換し、捕捉後に is_autocommit を検査して開きっぱなしの
/// トランザクションを ROLLBACK する（アクター生存 ≠ 接続健全のギャップを塞ぐ）。
fn run_guarded<T>(
    conn: &mut Connection,
    f: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let result = catch_unwind(AssertUnwindSafe(|| f(&mut *conn)))
        .unwrap_or_else(|_| Err("DB ジョブが panic しました".to_string()));
    if !conn.is_autocommit() {
        let _ = conn.execute_batch("ROLLBACK");
    }
    result
}

// テストは検証用に別接続で ghosts.db/user-data.db を直接開く（actor 経由の書込との整合を確認するため）。
#[cfg(test)]
#[allow(clippy::disallowed_methods)]
mod tests {
    use super::*;
    use crate::testutil::TempDirGuard;

    /// 一時ファイル上に (ghosts, user-data) を初期化してアクターを起動する。
    fn spawn_test_actor(dir: &TempDirGuard) -> ActorHandle {
        let ghosts = rusqlite::Connection::open(dir.path().join("ghosts.db")).unwrap();
        crate::commands::ghost::store::configure_connection(&ghosts).unwrap();
        crate::testutil::apply_cache_schema(&ghosts);
        let user = rusqlite::Connection::open(dir.path().join("user-data.db")).unwrap();
        crate::commands::launch_history::ensure_schema(&user).unwrap();
        spawn_actor(ghosts, user)
    }

    fn send_record(handle: &ActorHandle, key: &str) -> Result<(), String> {
        let (reply, rx) = tokio::sync::oneshot::channel();
        handle
            .send(Job::RecordLaunch { ghost_identity_key: key.to_string(), reply })
            .unwrap();
        rx.blocking_recv().unwrap()
    }

    #[test]
    fn record_launchジョブが両dbへ書き込み応答を返す() {
        let dir = TempDirGuard::new("actor_record_test");
        let handle = spawn_test_actor(&dir);
        send_record(&handle, "sspg").unwrap();
        // アクター所有と別の検証用接続で観測する
        let user = rusqlite::Connection::open(dir.path().join("user-data.db")).unwrap();
        let n: i64 = user
            .query_row("SELECT COUNT(*) FROM ghost_launches WHERE ghost_identity_key='sspg'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn panicジョブでもアクターが生存し次のジョブが成功する() {
        let dir = TempDirGuard::new("actor_panic_test");
        let handle = spawn_test_actor(&dir);
        let (reply, rx) = tokio::sync::oneshot::channel();
        handle.send(Job::PanicForTest { reply }).unwrap();
        let err = rx.blocking_recv().unwrap();
        assert!(err.is_err(), "panic はエラー応答へ変換される");
        // 接続健全性: panic の次のジョブが成功する（設計書 §3.1）
        send_record(&handle, "after-panic").unwrap();
    }

    #[test]
    fn reply受信側をdropしてもジョブは完走しアクターは継続する() {
        let dir = TempDirGuard::new("actor_reply_drop_test");
        let handle = spawn_test_actor(&dir);
        let (reply, rx) = tokio::sync::oneshot::channel();
        handle
            .send(Job::RecordLaunch { ghost_identity_key: "dropped".to_string(), reply })
            .unwrap();
        drop(rx); // 呼び出し側キャンセル
        send_record(&handle, "next").unwrap(); // 継続確認（前ジョブも DB には適用済み）
        let user = rusqlite::Connection::open(dir.path().join("user-data.db")).unwrap();
        let n: i64 = user.query_row("SELECT COUNT(*) FROM ghost_launches", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2, "reply drop されたジョブも完走している");
    }

    /// scan_and_store_blocking 相当の実ジョブを 2 本並行送信しても、単一 writer により
    /// 最終状態が「後勝ちの 1 状態」に収束する（旧 scan_lock配下の並行delta テストの後継）。
    #[test]
    fn 並行scanジョブが直列化され整合状態に収束する() {
        use std::fs;
        let dir = TempDirGuard::new("actor_scan_serialize");
        // 2 つの ssp ツリー（ghost_a / ghost_b）
        let (ssp_a, ssp_b) = (dir.path().join("ssp_a"), dir.path().join("ssp_b"));
        for (root, name) in [(&ssp_a, "ghost_a"), (&ssp_b, "ghost_b")] {
            let base = root.join("ghost").join(name).join("ghost").join("master");
            fs::create_dir_all(&base).unwrap();
            fs::write(base.join("descript.txt"), "name,Test\ncharset,UTF-8\n").unwrap();
        }
        let handle = spawn_test_actor(&dir);
        let mut rxs = Vec::new();
        for ssp in [&ssp_a, &ssp_b] {
            let (reply, rx) = tokio::sync::oneshot::channel();
            handle
                .send(Job::Scan {
                    ssp_path: ssp.to_string_lossy().to_string(),
                    additional_folders: Vec::new(),
                    request_key: "rk".to_string(),
                    cached_fingerprint: None,
                    reply,
                })
                .unwrap();
            rxs.push(rx);
        }
        for rx in rxs {
            rx.blocking_recv().unwrap().unwrap();
        }
        let conn = rusqlite::Connection::open(dir.path().join("ghosts.db")).unwrap();
        let ghosts: i64 = conn.query_row("SELECT COUNT(*) FROM ghosts WHERE request_key='rk'", [], |r| r.get(0)).unwrap();
        let entries: i64 = conn
            .query_row("SELECT COUNT(*) FROM ghost_scan_entries WHERE request_key='rk'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ghosts, 1, "直列化後は 1 体（後勝ちの entries）のはず");
        assert_eq!(ghosts, entries, "ghosts と scan_entries が整合しているはず");
    }

    #[test]
    fn 全senderのdropで受信ループが終了しスレッドリークしない() {
        let dir = TempDirGuard::new("actor_shutdown_test");
        let handle = spawn_test_actor(&dir);
        let thread = handle.thread_handle_for_test();
        drop(handle);
        // チャネルクローズ → run_loop が return する
        thread.join().expect("アクタースレッドが正常終了する");
    }
}
