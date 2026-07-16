//! `scan_and_store` の直列化ロック配線の回帰ガードだったファイル(#146 Phase2)。
//!
//! `scan_and_store` は Job::Scan（DB アクター）へ移植され、ScanCoordinator の
//! 外部ロック保持で直列化を検証する本テストの前提（Mutex を外から掴んで待たせる）が
//! 成立しなくなった。アクターは単一消費者キューであり、ScanCoordinator のような
//! 外部から保持できる lock を持たない。直列化の後継検証は
//! `actor::tests::並行scanジョブが直列化され整合状態に収束する`（src/actor/mod.rs）が担う。
//!
//! `record_launch` は Task 5 で既にアクター経由になり、このロックの配線対象外になっている
//! （このファイルにその回帰ガードは無かった）。
//!
//! このファイル自体・`ScanCoordinator`・`tests-common-controls-v6.manifest` は
//! Task 8 でまとめて撤去する（#146 Phase2 実装計画）。
