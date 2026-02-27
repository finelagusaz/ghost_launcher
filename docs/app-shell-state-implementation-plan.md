# 項目4 実装計画（`App.tsx` の画面状態制御ロジック分離）

## 背景
`docs/responsibility-separation-review.md` の項目4では、`App.tsx` に集約されている画面状態制御（設定ダイアログ開閉、検索時ページングリセット、スキャン完了トリガ等）を分離し、`App` を「画面構成」に寄せることが提案されている。

## 目標
- `App.tsx` の責務を「データ受け渡しとコンポーネント構成」に限定する。
- 画面状態制御は `useAppShellState`（仮）に集約する。
- 既存挙動（自動設定ダイアログ表示、検索時オフセット初期化、スキャン完了時の再検索トリガ）を壊さない。

## スコープ
### 対象
- `src/App.tsx`
- `src/hooks/useAppShellState.ts`（新規）
- `src/hooks/useAppShellState.test.ts`（新規）

### 非対象
- `useGhosts` / `useSearch` / `ghostCatalogService` の業務手順変更
- UI コンポーネント見た目の変更

---

## 小さなステップ

### Step 0: 現状挙動の固定（テスト観点の洗い出し）
- `App.tsx` にある以下の状態遷移を仕様化する。
  1. `settingsLoading=false && sspPath=null` で設定ダイアログを自動オープン
  2. `deferredSearchQuery` 変更時に `offset=0`
  3. `ghostsLoading: true -> false` 遷移時に `refreshTrigger++` と `offset=0`
- 期待値をテストケース名に落とす。

### Step 1: `useAppShellState` の最小骨格を追加
- `settingsOpen`, `offset`, `refreshTrigger` と setter を保持するだけの hook を追加。
- まだ副作用（`useEffect`）は移さない。
- `App.tsx` は新 hook を使うが、挙動が変わらない最小差分で置換。

### Step 2: 設定ダイアログ開閉ロジックを移管
- `settingsLoading` / `sspPath` を hook 引数に渡し、
  自動オープン副作用を hook 内へ移す。
- `openSettings` / `closeSettings` ハンドラを hook から返す。
- `App.tsx` の設定ダイアログ関連 `useEffect/useCallback` を削除。

### Step 3: 検索時ページングリセットを移管
- `deferredSearchQuery` を hook 引数に渡し、
  変更時 `offset=0` を hook 内副作用に移す。
- `App.tsx` から該当 `useEffect` を削除。

### Step 4: スキャン完了トリガを移管
- `ghostsLoading` を hook 引数に渡し、
  `true -> false` 遷移検知で `refreshTrigger++` と `offset=0` を hook 内へ移す。
- `prevLoadingRef` を hook 内に閉じ込める。

### Step 5: `loadMore` 判定を hook に部分移管（任意）
- `canLoadMore = !searchLoading && ghosts.length < total` の派生値を hook が返す。
- `App.tsx` 側は `if (canLoadMore) incrementOffset()` のみ。
- 影響が広い場合はこの step は分割 PR に切り出し可。

---

## テスト計画

### ユニットテスト（`useAppShellState.test.ts`）
1. `sspPath` 未設定時の `settingsOpen` 自動遷移
2. `deferredSearchQuery` 変更時の `offset` リセット
3. `ghostsLoading` の `true -> false` で `refreshTrigger` 増分
4. `openSettings` / `closeSettings` / `setSettingsOpen` の整合性

### 既存テスト
- `npm test` を実行し既存テストの退行がないことを確認。

### 手動確認
- 設定未入力起動時に設定ダイアログが開く
- 検索文字変更時に先頭ページへ戻る
- 再読込完了後に一覧が更新される

---

## 受け入れ条件（Done）
- `App.tsx` から以下が削減されていること
  - `settingsOpen` 自動制御の副作用
  - `offset` リセット副作用
  - `refreshTrigger` 更新副作用
- 上記挙動が hook テストで担保されていること
- `npm test` が成功すること

## リスクと回避策
- リスク: 副作用移管で依存配列ミスが起こる
  - 回避: Step ごとに `npm test` 実行、失敗時は直前 Step に戻す
- リスク: 無限再レンダリング
  - 回避: hook の返り値 API を最小化し、`useCallback` で安定化

## 推奨 PR 分割
- PR1: Step 1〜2（設定ダイアログ分離）
- PR2: Step 3〜4（検索/スキャン状態分離）
- PR3: Step 5（必要時のみ）
