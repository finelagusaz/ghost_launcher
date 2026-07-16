//! ghosts.db への全書き込みを直列化する単一 writer アクター（設計書 §2/§3）。
//! Connection はこのスレッドだけが所有する。排他は「消費者が 1 人のキュー」という構造
//! そのものであり、Mutex もロック配線テストも存在しない。
//!
//! #146 Phase2 の段階配線: `spawn_actor` を呼び `.manage(ActorHandle)` するのは Task 7
//! （lib.rs の setup 配線）。それまでは受信ループ以下（spawn_actor/run_loop/handle_job/
//! run_guarded・Job のフィールド読み取り）が本番コードから到達不能なため、dead_code を
//! 一時的に許可する（テストのみが到達する）。Task 7 で配線後にこの allow は不要になる。
#![allow(dead_code)]

use rusqlite::Connection;
use std::panic::{catch_unwind, AssertUnwindSafe};
use tokio::sync::{mpsc, oneshot};

/// ghosts.db への書き込みの全種類（設計書 §3）。新しい writer は必ずここに variant を足す。
pub(crate) enum Job {
    RecordLaunch {
        ghost_identity_key: String,
        reply: oneshot::Sender<Result<(), String>>,
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

#[cfg(test)]
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
