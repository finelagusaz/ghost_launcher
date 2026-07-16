fn main() {
    tauri_build::build();

    // Windows のテストバイナリに common-controls v6 マニフェストを埋め込む。
    // tauri の `test` フィーチャ（dev-dependencies で有効化）を使うと、mock_runtime 経由で
    // comctl32 v6 専用の entrypoint（TaskDialogIndirect / *WindowSubclass）が静的インポートされる。
    // マニフェストが無いと comctl32 v5.82 に束縛され、テストバイナリが
    // STATUS_ENTRYPOINT_NOT_FOUND でロードできない。
    // `-tests` スコープのため本番バイナリ（tauri_build が別途マニフェストを埋め込む）には影響しない。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests-common-controls-v6.manifest");
        println!("cargo:rerun-if-changed=tests-common-controls-v6.manifest");
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
}
