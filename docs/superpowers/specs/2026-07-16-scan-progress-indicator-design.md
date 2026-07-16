# 設計書: スキャン中インジケータ（軽量・非確定・上部バー）

- 日付: 2026-07-16
- 関連: issue #134 Phase 3（非ブロッキング化）の軽量版。フル進捗（streaming/イベント）は本設計の非スコープ。
- 種別: フロントエンドのみ（Rust・IPC・DB は無変更）

## 1. 問題

`scan_and_store`（再スキャン）の実行中、**既に一覧が表示されている状態**ではユーザーへの可視フィードバックが無い。
現状の loading 表現は 2 つだけ:

- **初回スキャン（キャッシュ空）**: `GhostList.tsx:145` が `(loading || searchLoading) && total===0 && ghosts.length===0` のとき
  全画面スピナー（`t("list.loading")`）を出す。→ カバー済み。
- **再スキャン（一覧あり）**: reload・フォルダ追加・設定変更後。`useGhosts` の `loading=true` だが、上記スピナー条件を
  満たさず何も描かれない。可視の変化は `AppHeader` の refresh ボタンが `disabled` になるのみ（`AppHeader.tsx:61`）。

warm 再スキャンは delta 化（PR #143）で ~1.40s に短縮されたが、cold cache・大量フォルダでは数秒に達しうる。
その間「固まった？」と誤解させる体感の穴が実在する。

## 2. スコープ / 非スコープ

- **スコープ**: 再スキャン中に「背景で走査中」と分かる**非確定（indeterminate）**の軽量インジケータ。既存の `loading`
  状態のみを用い、backend は無変更。一覧は覆わず操作可能なまま（`2868e29`「一覧非破壊化」に整合）。
- **非スコープ**: 進捗（X/N 体）の確定表示。Rust→JS のイベント配信（channel＋ts-rs 型）と IPC 拡張を要するため
  issue #134 Phase 3 本体として別途扱う。初回スキャンの全画面スピナー（既存・変更しない）。

## 3. 採用アプローチ

**AppHeader 直下に 2px の非確定 ProgressBar（Fluent `ProgressBar`・value 省略）** を、再スキャン中のみ表示する。
VS Code 風の「背景作業中」表現で、主張は最小限。テーマ追従のブランド色。

代替案と不採用理由:
- ツールバーの小 Spinner: 視線の先だが、ツールバー行のレイアウトに影響しやすい。バーの方が非侵襲。
- ヘッダーの状態文字: 文言 i18n が増え、タイトル周辺が賑やかになる。
- 一覧オーバーレイ: 一覧非破壊化の思想に反する。

## 4. コンポーネント構成（SRP）

- **`useScanIndicator(active: boolean): boolean`**（`src/hooks/`）— ちらつき防止の遅延しきい値ロジックを隔離。
  `active` が **`SCAN_INDICATOR_DELAY_MS`（=300ms）以上継続したときだけ** `true` を返す。`active` が false に
  なった瞬間は即 `false`（保留中タイマーは解除）。純ロジックで fake timers によりテスト可能。
- **`ScanProgressBar`（`src/components/`）** — `visible: boolean` を受け、2px の非確定 `ProgressBar` を描画/非描画する
  だけの表示専用コンポーネント。可視判定・しきい値は持たない。
- **`App.tsx`** — 既に持つ `ghostsLoading` と `hasCachedDisplay`（`App.tsx:162` の再利用）から
  `const showScanBar = useScanIndicator(ghostsLoading && hasCachedDisplay);` を導出し、`<AppHeader/>` と
  `<GhostContent/>` の間に `<ScanProgressBar visible={showScanBar} />` を差す。

依存関係: `ScanProgressBar` は Fluent の `ProgressBar` のみに依存。`useScanIndicator` は React（timers）のみ。App が両者を配線。

## 5. 表示ロジック

- **可視条件（active）**: `ghostsLoading === true` かつ `hasCachedDisplay === true`（＝一覧が既に見えている再スキャン）。
  初回（`total===0 && ghosts.length===0`）は `hasCachedDisplay` が false のためバーは出ず、既存の全画面スピナーに委ねる
  （二重表示しない・排他が構造的に保証される）。
- **遅延しきい値（ちらつき防止）**: `useScanIndicator` が active の 300ms 継続を待ってから可視化する。Layer 1 ヒット
  （~1ms）や warm な瞬間再スキャンではバーは一切現れず、cold・大量フォルダの数秒スキャンでのみ現れる。
- **消滅**: active が false になれば即時に非表示（最小表示時間は設けない。数秒スキャンでのみ出るため点滅しない）。

## 6. レイアウト（シフト回避）

バーの出現/消滅で一覧が縦に揺れないよう、**レイアウトシフトを起こさない**配置とする。具体策（実装計画で確定）:
常に 2px のトラック高を確保し idle 時は背景を透明にする、または AppHeader の `borderBottom` 直下にトラックを重ねる。
いずれも「出た瞬間に下の一覧が 2px 下がる」現象を避けることを要件とする。

## 7. アクセシビリティ / i18n

- バーに `aria-label={t("list.scanning")}`。Fluent `ProgressBar` は `role="progressbar"` を付与する。value 省略で
  非確定（`aria-valuenow` なし）。
- 一覧は非ブロッキングのため `aria-busy` は**付けない**（操作を妨げないことを明示）。
- i18n: フラットキー `list.scanning`（例: 日本語「スキャン中...」）を 6 ロケール（ja/en/zh-CN/zh-TW/ko/ru）へ追加。
  バー自体はテキストを表示しない（aria 専用）。`docs/locale-customization.md` のキー一覧も同期。既存 `list.loading` は
  初回スピナーが使用中のため流用しない。

## 8. テスト方針

- **`useScanIndicator`**（`src/hooks/useScanIndicator.test.ts`・`renderHook` + fake timers）:
  - active=true が 300ms 未満で false に戻ると一度も true にならない（ちらつき防止）。
  - active=true が 300ms 継続で true になる。
  - true の後 active=false で即 false。
- **`ScanProgressBar`**（`src/components/ScanProgressBar.test.tsx`・`render`）: `visible=true` で `role="progressbar"` が
  存在し `aria-label` が付く／`visible=false` で描画されない（またはトラックのみで progressbar が無い）。
- 既存回帰: 初回スピナー（`GhostList`）とバーが排他であること（`hasCachedDisplay` による）を既存テストで担保、
  必要なら App レベルの結線テストを追加。

## 9. 検証

`npm test`・`npm run build`・`npm run check:ui-guidelines`・`npm run test:ui-guidelines-check`。新規 UI のため
UI ガイドライン（`docs/ui-guidelines.md`）準拠を `ux-reviewer` で確認。backend 無変更のため Rust テスト・
生成型は不変（`/ipc-check` は非該当）。
