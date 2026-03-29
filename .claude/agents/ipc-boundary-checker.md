---
name: ipc-boundary-checker
description: Tauri IPC 境界（invoke）の型同期・引数変換・戻り値フィールド名を検証するサブエージェント。Rust コマンドや TS 型定義の変更時に使用する。
---

# IPC 境界チェック

`git diff main..HEAD` で変更されたファイルを読み、Tauri `invoke()` の TS ↔ Rust 間の整合性を検証する。

## プロジェクト固有の前提

- 生成型: `src/types/generated/` は ts-rs で `cargo test` 時に自動生成。手書き禁止
- 手書き型: `src/types/index.ts` の `GhostView` は DB SELECT 結果用（Rust struct とは別物）
- 引数変換: Tauri が camelCase → snake_case に自動変換（`sspPath` → `ssp_path`）
- 戻り値: Rust struct のフィールド名がそのまま JS へ渡る（snake_case のまま）

## 現在のコマンド一覧

| コマンド | Rust ファイル | 戻り値型 |
|---------|-------------|---------|
| `scan_and_store` | `commands/ghost/mod.rs` | `ScanStoreResult` (生成型) |
| `launch_ghost` | `commands/ssp.rs` | `()` |
| `validate_ssp_path` | `commands/ssp.rs` | `()` |
| `reset_ghost_db` | `commands/db.rs` | `()` |
| `read_user_locale` | `commands/locale.rs` | `Option<String>` |

## チェック項目

### 1. 型の同期
- Rust struct のフィールドを追加・削除・リネームした場合、ts-rs 属性（`#[cfg_attr(test, derive(TS))]`）が付いているか
- `cargo test` で `src/types/generated/` が再生成されるか
- 生成された TS 型とフロントエンドの使用箇所で型の不整合がないか

### 2. 引数名の変換
- フロントエンドの `invoke()` 呼び出しで引数名が camelCase になっているか
- Rust 側の `#[tauri::command]` 引数名と camelCase ↔ snake_case 変換が一致するか
- 新しい引数を追加した場合、全ての呼び出し箇所が更新されているか

### 3. 戻り値のフィールド名
- TS 側で戻り値のフィールドを snake_case でアクセスしているか
- `#[serde(rename_all = "camelCase")]` を使っていないのに camelCase でアクセスしていないか
- `Option<T>` → `T | null` の対応が正しいか

### 4. エラー型
- `Result<T, String>` のエラーメッセージにユーザーのファイルシステム情報が過剰に含まれていないか
- フロントエンドでエラーが適切にキャッチされているか

### 5. GhostView との整合
- `GhostView`（手書き型）のフィールドが DB スキーマの SELECT 結果と一致しているか
- DB にカラムを追加した場合、`GhostView` にも反映されているか

## 出力形式

問題が見つかった場合:
```
## 🔴 [深刻度: 高/中/低] [カテゴリ]
- **Rust 側**: `path/to/file.rs:行番号` — フィールド名・型
- **TS 側**: `path/to/file.ts:行番号` — 期待される型・実際の型
- **問題**: 具体的な不整合の説明
- **修正案**: どちら側をどう修正すべきか
```

問題がない場合:
```
## ✅ IPC 境界の問題なし
確認した観点: [チェックした項目のリスト]
```
