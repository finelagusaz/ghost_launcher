---
name: ipc-check
description: Tauri IPC 境界（Rust↔TS）の契約を検証する。src-tauri/src/commands/ 配下・invoke ラッパー（src/lib/）・src/types/generated/ に触れる変更をしたとき、または「/ipc-check」と言われたときに使う。
---

# IPC 境界の契約検証

Rust と TypeScript の境界を越える変更が、両側の契約を保っているか検証する。

## 検査 1: 生成型の同期

IPC struct（`#[cfg_attr(test, derive(TS))]` 付き）を変更した場合:

```bash
cargo test --workspace
git status --porcelain src/types/generated/
```

`cargo test` 実行時に `src/types/generated/` へ TS 型が自動生成される。差分・未追跡ファイルが出たら**コミットに含める**（CI の「Verify generated types are committed」が照合する）。手書きで TS 型を定義しない。

## 検査 2: 命名変換の非対称

- **引数**: `invoke()` の camelCase 引数は Rust 側で snake_case に自動変換される（例: `sspPath` → `ssp_path`）
- **戻り値**: フィールド名は**変換されない**。`#[derive(Serialize)]` がそのまま JS に渡るため、TS 側は Rust のフィールド名（snake_case）と完全一致していること

変更したコマンドの引数・戻り値それぞれについて、この非対称の取り違えがないか両側のコードを突き合わせる。

## 検査 3: セマンティクス変更

戻り値の「空・省略・null」の意味を変えた変更（例: `cache_hit=true` のとき `total: 0` を「0 件」でなく「省略」の意味で返す）では:

1. その戻り値を受け取る**全コードパス**を検索して列挙する
2. 各受け手が新しい意味で正しく解釈するか確認する

型シグネチャが同じままの意味変更はコンパイラで検知できない。過去にこのパターンで DB 全削除バグが発生している。

## 検査 4: テストモック契約監査

`invoke` をモックするテストについて:

1. モックの戻り値が Rust 側の実装で**実際に発生しうる組み合わせ**か確認する（例: `cache_hit=true` なら Rust は必ず `total: 0` を返す。`cache_hit: true, total: 1` は現実に発生しない）
2. 発生しない組み合わせを返すモックは、本物のバグを検知できない無意味テスト。実契約に合わせて修正する

## サブエージェント委譲

変更が複数コマンドにまたがる・IPC struct の増減があるなど大きい場合は、`ipc-boundary-checker` サブエージェントに検査を委譲し、このスキルは検査観点の指定と結果の判定に徹する。

## 出力

検査 1〜4 それぞれについて ✅（問題なし）/ ⚠️（要修正、根拠 file:line 付き）を報告する。
