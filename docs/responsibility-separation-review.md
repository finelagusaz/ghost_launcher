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
