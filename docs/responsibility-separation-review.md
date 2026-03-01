# 責務分離レビュー（2026-02-27）

## 対象
- `src/App.tsx`
- `src/hooks/useGhosts.ts`
- `src/hooks/useSearch.ts`
- `src/lib/ghostScanOrchestrator.ts`

## 総評
- 現状は `UI（App/Component）`、`ユースケース（hooks）`、`インフラ連携（lib）` が概ね分かれており、責務分離の方向性は良いです。
- ただし `useGhosts` に「オーケストレーション・キャッシュ判定・DB初期確認・エラー整形」が集中しており、変更理由が異なる関心事が混在しています。

## 良い点
1. **スキャンの重複排除を lib に隔離できている**
   - `pendingScans` による同一 `requestKey` の共有は、並行実行制御という明確な責務を `ghostScanOrchestrator.ts` に閉じ込められています。
2. **検索処理が `useSearch` に分離されている**
   - `App` が直接 DB クエリを持たず、検索用 hook に委譲されているため、UI とデータ取得の境界が明確です。
3. **リクエストキー生成ロジックが utility 化されている**
   - `buildRequestKey/buildAdditionalFolders` により、キー仕様の散在を抑えています。

## 改善ポイント（優先順）

### 1) `useGhosts` の責務過多（最優先）
`useGhosts` は現在、次を同時に担っています。
- React 状態管理（loading/error）
- 直列化制御（`inFlightKeyRef`/`requestSeqRef`）
- キャッシュ検証フロー（fingerprint 取得・比較）
- DB 生存確認（`searchGhosts(..., 1, 0)`）
- スキャン実行と DB 保存
- エラー文言変換

#### 推奨
- `useGhosts` は「画面向け状態遷移」へ限定し、実処理は `lib` 側の `refreshGhostCatalog` のようなユースケース関数へ移譲する。
- 例:
  - `lib/ghostCatalogService.ts`
    - `refreshGhostCatalog({ sspPath, ghostFolders, forceFullScan })`
    - `validateAndMaybeSkipScan(...)`
    - `persistScanResult(...)`

### 2) キャッシュ媒体（localStorage）の責務位置
- キャッシュ媒体が `hook` 側に露出しているため、UI 層変更が永続化仕様に波及しやすいです。

#### 推奨
- fingerprint の読み書きは `lib/settingsStore.ts` もしくは専用 `lib/fingerprintCache.ts` に寄せる。
- `useGhosts` は `getCachedFingerprint/setCachedFingerprint` の抽象 API のみ利用する。

### 3) DB 初期確認の意図が暗黙
- `searchGhosts(..., 1, 0)` で「DBに1件以上あるか」を判定していますが、意図がコードから読み取りにくいです。

#### 推奨
- `ghostDatabase.ts` に `hasGhosts(requestKey): Promise<boolean>` を追加し、意図を名前で表現する。

### 4) `App.tsx` の画面制御ロジック肥大化
- `settingsOpen` の自動開閉、`refreshTrigger`、ページング offset リセットなどの画面状態制御が増えてきています。

#### 推奨
- `useAppShellState`（仮）を作り、App は「構成」に専念させる。
- これにより UI の見通しを維持しつつ、今後の機能追加（絞り込み条件や複数ソート）に備えやすくなる。

## 参考リファクタリング順
1. `ghostDatabase.hasGhosts` を追加（意味の明確化）
2. fingerprint キャッシュ API を lib に抽出
3. `refreshGhostCatalog` を追加し `useGhosts` から業務手順を移す
4. 必要なら `useAppShellState` へ App の画面状態を段階移管

## 期待効果
- 変更波及範囲の縮小（UI変更でデータ層に触れにくくなる）
- hook 単体テストが簡素化（状態遷移のみに集中）
- スキャン戦略（差分更新・TTL導入等）の差し替え容易性向上

## 追加考慮: キャッシュDB仕様（10万レコード超対応版）

本章は、今後の DB 変更方針とキャッシュ運用を **10万レコード超** を前提に標準化するための仕様です。
対象は `ghosts.db` とし、`ghosts` は揮発キャッシュ、将来追加される `favorites` / `history` / `settings` は永続データとして明確に分離します。

### 1. 仕様の前提（SLO / 容量 / データ特性）

- 想定データ件数
  - 通常: 3万〜10万件
  - ピーク: 10万件超（運用上限は当面 20万件までを設計対象）
- 特性
  - `ghosts` は「ファイルシステムの索引」であり、再構築可能
  - 永続ユーザーデータは消失不可（お気に入り・履歴・設定）
- 最低限の運用目標（目安）
  - 一覧検索（`COUNT + SELECT LIMIT/OFFSET`）p95: 300ms 以内
  - 強制再読込（scan→保存）完了時間: 端末性能依存だが、劣化傾向を監視して回帰検知する

### 2. データモデル方針（Volatile / Persistent 分離）

#### 2.1 Volatile（破壊可能）
- `ghosts` テーブル
- ルール
  - スキーマ変更時に `DELETE` / 再作成を許容
  - キャッシュ不整合時はフルスキャンで自己修復

#### 2.2 Persistent（保持必須）
- 例: `favorites`, `launch_history`, `settings`, `usage_stats`
- ルール
  - マイグレーションで既存データを消さない
  - 破壊的変更時は移行 SQL を必須化

### 3. キー設計仕様（将来テーブル追加時の必須要件）

- **禁止**: `ghosts.id`（連番）を外部参照キーに使う
- **推奨**: 自然キーの複合化
  - 最低: `source + directory_name`
  - 文脈衝突を避ける必要がある場合: `normalized_ssp_path + source + directory_name`
- `favorites` 等の永続テーブルは、`ghosts` の再投入後も再結合できるキーで設計する

### 4. マイグレーション仕様

#### 4.1 `ghosts` スキーマ変更時
- 必須手順
  1) 必要な `ALTER TABLE` / インデックス変更を実施
  2) `DELETE FROM ghosts;` を同 migration に含める
- 理由
  - 既存行の新規列未充足を残さないため
  - 次回起動時、`hasGhosts=false` を契機にフルスキャンで完全再投入させるため

#### 4.2 Persistent スキーマ変更時
- 必須手順
  - 既存データ保持を前提に移行 SQL を実装
  - 互換性が崩れる場合は段階移行（新列追加→バックフィル→参照切替）

### 5. 寿命管理仕様（10万件超を見据えた標準）

#### 5.1 保持ポリシー
- `request_key` 世代保持: 最新 5 世代
- TTL: 30 日
- 実際の削除条件: **世代超過 OR TTL超過**

#### 5.2 実行タイミング
- 軽量クリーンアップ: `replaceGhostsByRequestKey` 成功直後
- 重量クリーンアップ（必要時）: 起動時 1 回
  - 条件例: DB サイズ閾値超過、削除累積量超過

#### 5.3 物理サイズ管理
- 通常: `PRAGMA optimize`
- 容量逼迫時: `VACUUM` を非対話タイミングで実行
- `auto_vacuum` は書き込み頻度への影響を計測後に採用判断

### 6. 10万件超で顕在化するリスク

- 検索
  - `COUNT(*)` / `LIKE` / `OFFSET` の遅延増加
  - 旧世代残存により全体件数が膨張し、p95 が悪化
- 書き込み
  - `DELETE -> INSERT` の index 更新コスト増加
  - WAL 増大で保存完了遅延が体感化
- 安定性
  - 書き込み時間増加により待機競合が増え、失敗率が上がる可能性
- 容量
  - 削除のみではファイル縮小しないため、`VACUUM` 遅延時に容量圧迫

### 7. インデックス設計ガイド

- 維持
  - `request_key`
  - `request_key + name_lower`
  - `request_key + directory_name_lower`
- 寿命管理列（`updated_at` など）を導入する場合
  - 削除クエリの実行計画を確認して必要最小限で付与
- 注意
  - インデックス追加は読み取り改善と引き換えに書き込みコストを増やす

### 8. 監視・アラート仕様

#### 8.1 収集項目（必須）
- `ghosts` 総件数
- `request_key` ごとの件数
- 検索 p95（`COUNT`, `SELECT ... LIMIT/OFFSET`）
- `ghosts.db` ファイルサイズ
- scan 完了から保存完了までの時間

#### 8.2 推奨アラート閾値（初期値）
- 総件数 > 100,000
- DB サイズが運用基準値を継続超過
- 検索 p95 が 300ms を継続超過

### 9. 実装タスク（優先順位）

1. `ghosts` に `updated_at` を追加し、保持世代 + TTL クリーンアップを実装
2. 起動時の条件付きメンテナンス（`PRAGMA optimize` / 必要時 `VACUUM`）を追加
3. 永続テーブル追加時のキー仕様（`source + directory_name` 以上）を設計規約化
4. migration 追加時チェックリストに「`ghosts` 変更時の全消去」を明記
5. 監視項目をログ/メトリクスで可視化し、3万件時点から定点観測開始

### 10. 仕様変更時のレビュー観点

- この変更は Volatile / Persistent のどちらに属するか
- 再投入で壊れる参照（ID依存）がないか
- 10万件時の検索/保存/容量コストが悪化しないか
- クリーンアップとメンテナンスの自動実行条件が明確か
- 監視値で劣化を検知できるか
