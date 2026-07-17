---
name: cache-check
description: キャッシュ・状態遷移の整合性を検証する。キャッシュ（localStorage/ghosts.db）・fingerprint・request_key・DB スキーマ・状態管理に触れる変更をしたとき、または「/cache-check」と言われたときに使う。
---

# キャッシュ・状態整合検証

多層キャッシュと永続データの整合性が変更後も保たれているか検証する。

## 前提となる構造

- **ghosts.db** — 揮発キャッシュ。書き込みは GhostDbActor（rusqlite）経由のみ・JS/sqlx は読み取り専用。使い捨てスキーマ: `CACHE_SCHEMA` のハッシュを `user_version` に刻み、不一致なら起動時に全 DROP+CREATE で**自動リビルド**（フルスキャンで再投入）
- **user-data.db** — 永続データ（Rust 専有・rusqlite 単一接続）。起動履歴 `ghost_launches` の唯一の住処。JS からアクセスしない
- **localStorage** — 設定・キャッシュ寿命管理
- 詳細は `src-tauri/CLAUDE.md`「SQLite」節と `SPEC.md` §4.5/§6.6 を参照

## 検査 1: 2 層キャッシュの独立リセット耐性

localStorage と SQLite は独立にリセットされうる。変更後も以下が成り立つか確認する:

- 片側だけ消えたケース（DB のみ空 / localStorage のみ空）で、不整合な表示・誤った差分判定にならないか
- 「DB 空 → fingerprint を送らない → 必ずフルスキャン」の安全弁が変更後も維持されているか

## 検査 2: 揮発/永続の分離

- 永続データ（起動履歴・将来の favorites 等）が揮発キャッシュ ghosts.db 側に置かれていないか（運命共有の再発）
- 永続テーブルのマイグレーションに `DELETE FROM` が混入していないか
- ゴーストへの外部参照が `ghosts.id`（再投入で変わる）でなく `ghost_identity_key` を使っているか

## 検査 3: 非正規化集計列の同期経路

`last_launched` / `launch_count` は user-data.db から再導出可能な導出キャッシュ。更新経路が両方揃っているか確認する:

1. **即時更新**: `record_launch` が INSERT と同時に ghosts 側を UPDATE しているか
2. **backfill**: `scan_and_store` のキャッシュ再構築後に集計を書き戻しているか

片方だけ変更すると、スキャンのたびに集計がずれる。

## 検査 4: 使い捨てスキーマの単一権威

ghosts.db はマイグレーションを持たない（`CACHE_SCHEMA` が単一権威・ハッシュ `user_version` 不一致で全リビルド）。スキーマに触れる変更で確認する:

- ghosts.db のスキーマ変更が `cache_schema.rs` の `CACHE_SCHEMA` の直接編集で行われているか（アクター外・別経路の DDL を足していないか）
- スキーマ変更 = 次回起動で全ユーザーのキャッシュ破棄＋フルスキャン再投入。このコストが変更に見合うか
- user-data.db（永続）をこの機構に巻き込んでいないか（永続側は `launch_history::ensure_schema` の追加式のみ。検査 2 も参照）
- index の追加・列同乗（カバリング化）を含む場合、狙った形状だけでなく**同じ index を線形に歩く既存形状（OFFSET ページング等）を bench 全形状で再実測**し差分を記録したか（epic #140 Phase 2 の search_text 同乗で offset/deep が 4ms→14ms に太った教訓。検収実測が狙い撃ちだと副作用に気づけない）

> **委譲**: DB スキーマ変更を含む場合、インデックス設計・クエリ効率の詳細検査は `sqlite-tuning` サブエージェントが一次担当。このスキルは 2 層キャッシュ整合の観点に絞り、重複検査を避ける。

## 検査 5: 状態遷移の到達可能性

新しい状態・フラグ・キャッシュキーを追加した場合:

- すべての遷移経路で初期値が定義されているか
- リセット経路（DB リセット・設定クリア・再スキャン）で新しい状態も正しく初期化されるか
- 到達不能な状態や、抜け出せない状態が生まれていないか

## 出力

検査 1〜5 それぞれについて ✅ / ⚠️（根拠 file:line 付き）を報告する。
