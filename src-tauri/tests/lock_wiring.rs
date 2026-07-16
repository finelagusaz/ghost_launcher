//! `scan_and_store` の直列化ロック配線の回帰ガード（統合テスト）。
//! `record_launch` は DB アクター経由になりこのロックの配線対象外になった（#146 Phase2）。
//!
//! `mock_builder` で実際に呼び、外部から `ScanCoordinator` のロックを保持している間は
//! コマンドが完了しない（`spawn_blocking` 内の `lock.lock()` 待ちでブロックする）ことを確認する。
//! 本番の `let _guard = lock.lock()...` 行を消すと、コマンドはロックを取らずに即完了して赤くなる。
//! これは `ScanCoordinator` の素の Mutex を 2 スレッドで叩くだけの合成テストでは捕捉できない、
//! 「コマンド本体にロックが配線されているか」を縛る回帰ガードである。
//!
//! なぜ lib ユニットテストではなく統合テスト（tests/）に置くか:
//! `mock_builder`（tauri の `test` フィーチャ）は `mock_runtime` 経由で comctl32 v6 専用の entrypoint
//! （`TaskDialogIndirect` / `*WindowSubclass`）を静的インポートする。これを解決する
//! common-controls v6 マニフェストは、`build.rs` の `cargo:rustc-link-arg-tests` で統合テストバイナリに
//! のみ埋め込める（lib ユニットテストハーネスにはこのスコープが届かず、埋め込むと本番 bin と競合する）。
//! このためロック配線テストは lib 内ではなくここに置く。

use ghost_launcher_lib::{scan_and_store, ScanCoordinator};
use std::sync::mpsc;
use std::time::Duration;
use tauri::test::MockRuntime;
use tauri::Manager;

/// `ScanCoordinator` を manage した `mock_builder` 製のテスト用 App を作る。
/// `identifier` を一意にすることで `app_config_dir`（= `config_dir()/{identifier}`）を実在しない
/// サブディレクトリへ逃がし、`scan_and_store` の DB open が実ファイルへ及ばないようにする
/// （テストの純粋性）。
fn build_mock_app(identifier: &str) -> tauri::App<MockRuntime> {
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = identifier.to_string();
    tauri::test::mock_builder()
        .manage(ScanCoordinator::default())
        .build(context)
        .expect("mock app のビルドに失敗")
}

/// 外部から `ScanCoordinator` ロックを保持している間、`run` が駆動するコマンドが完了しない
/// （＝直列化ロックが本番コードに配線されている）ことを検証する。ロック解放後の完了も確認する。
/// `run` はコマンド future を `block_on` で駆動しきる同期クロージャ（`State` は AppHandle から内部で取得する）。
/// コマンドは mock 環境で内部エラーになり得るが、ロック保持中はその手前でブロックするため判別に影響しない。
fn assert_serialized_by_lock(
    app: &tauri::App<MockRuntime>,
    run: impl FnOnce(tauri::AppHandle<MockRuntime>) + Send + 'static,
) {
    // app.state と、コマンド内部の handle.state は同一の managed Arc を指す（判別が成立する前提）。
    let lock = app.state::<ScanCoordinator>().0.clone();
    let handle = app.handle().clone();

    // 外部でロックを保持する（コマンドは spawn_blocking 内でこのロック取得に入る）。
    let guard = lock.lock().unwrap();

    let (tx, rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        run(handle);
        let _ = tx.send(());
    });

    // ロック保持中はコマンドが完了しない（本番の lock.lock() 行を消すと即完了して赤くなる）。
    assert!(
        rx.recv_timeout(Duration::from_millis(500)).is_err(),
        "外部ロック保持中にコマンドが完了した（直列化ロックが配線されていない）"
    );

    // ロックを解放するとコマンドが完了する。
    drop(guard);
    assert!(
        rx.recv_timeout(Duration::from_secs(5)).is_ok(),
        "ロック解放後もコマンドが完了しない"
    );
    worker.join().unwrap();
}

#[test]
fn scan_and_storeは外部ロック保持中は完了せずロック解放後に完了する() {
    let app = build_mock_app("com.ghostlauncher.scan-lock-test");
    assert_serialized_by_lock(&app, |handle| {
        tauri::async_runtime::block_on(async {
            let coordinator = handle.state::<ScanCoordinator>();
            let _ = scan_and_store(
                handle.clone(),
                "dummy_ssp".to_string(),
                Vec::new(),
                "rk-scan-lock-test".to_string(),
                None,
                coordinator,
            )
            .await;
        });
    });
}
