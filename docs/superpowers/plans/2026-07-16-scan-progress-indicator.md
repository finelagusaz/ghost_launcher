# スキャン中インジケータ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 再スキャン中（既に一覧が見えている状態）に「背景で走査中」と分かる軽量な非確定バーを、既存 `loading` 状態のみで表示する。

**Architecture:** ちらつき防止の遅延しきい値ロジックを純フック `useScanIndicator` に隔離し、表示専用の `ScanProgressBar`（Fluent `ProgressBar`）を App が `AppHeader` 直下に差す。可視条件は「`ghostsLoading` かつ既に一覧あり（`hasCachedDisplay`）」。backend・IPC・DB は無変更。

**Tech Stack:** React 19 / TypeScript / Fluent UI v9（`@fluentui/react-components`）/ react-i18next / vitest + @testing-library/react（+ jest-dom matchers・fake timers）。

## Global Constraints

- backend・IPC・Rust・DB は無変更（純フロントエンド）。
- 一覧は覆わず操作可能なまま（`2868e29` 一覧非破壊化に整合）。
- バーの出現/消滅で**レイアウトシフトを起こさない**（常に 2px のトラック高を確保）。
- 初回スキャン（一覧なし）は既存の全画面スピナー（`GhostList.tsx` の `t("list.loading")`）に委ね、二重表示しない。
- i18n はフラットキー。翻訳リソースは 6 ロケール（`ja` / `en` / `zh-CN` / `zh-TW` / `ko` / `ru`）を必ず揃える。
- 遅延しきい値は `SCAN_INDICATOR_DELAY_MS = 300`（ms）。
- テスト: フックは `renderHook`（`src/hooks/*.test.ts`）、コンポーネントは `render`（`src/components/*.test.tsx`）。jest-dom matcher は `src/test/setup.ts` で設定済み。
- 設計書: `docs/superpowers/specs/2026-07-16-scan-progress-indicator-design.md`。

---

### Task 1: `useScanIndicator` フック（遅延しきい値ロジック）

**Files:**
- Create: `src/hooks/useScanIndicator.ts`
- Test: `src/hooks/useScanIndicator.test.ts`

**Interfaces:**
- Produces: `export const SCAN_INDICATOR_DELAY_MS = 300;` / `export function useScanIndicator(active: boolean): boolean`
  — `active` が `SCAN_INDICATOR_DELAY_MS` 以上継続したときだけ `true`。`active` が false になった瞬間は即 `false`。

- [ ] **Step 1: 失敗するテストを書く**

`src/hooks/useScanIndicator.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScanIndicator, SCAN_INDICATOR_DELAY_MS } from "./useScanIndicator";

describe("useScanIndicator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("active が しきい値未満で解除されると一度も true にならない（ちらつき防止）", () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useScanIndicator(active),
      { initialProps: { active: true } },
    );
    act(() => { vi.advanceTimersByTime(SCAN_INDICATOR_DELAY_MS - 1); });
    expect(result.current).toBe(false);
    rerender({ active: false });
    act(() => { vi.advanceTimersByTime(10); });
    expect(result.current).toBe(false);
  });

  it("active が しきい値以上継続で true になる", () => {
    const { result } = renderHook(
      ({ active }: { active: boolean }) => useScanIndicator(active),
      { initialProps: { active: true } },
    );
    act(() => { vi.advanceTimersByTime(SCAN_INDICATOR_DELAY_MS); });
    expect(result.current).toBe(true);
  });

  it("true の後に active=false で即 false に戻る", () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useScanIndicator(active),
      { initialProps: { active: true } },
    );
    act(() => { vi.advanceTimersByTime(SCAN_INDICATOR_DELAY_MS); });
    expect(result.current).toBe(true);
    rerender({ active: false });
    expect(result.current).toBe(false);
  });
});
```

- [ ] **Step 2: テストを実行し失敗を確認**

Run: `npx vitest run src/hooks/useScanIndicator.test.ts`
Expected: FAIL（`useScanIndicator` が存在しない＝解決エラー）

- [ ] **Step 3: 最小実装を書く**

`src/hooks/useScanIndicator.ts`:

```ts
import { useEffect, useState } from "react";

/** スキャン中インジケータを表示し始めるまでの遅延（ちらつき防止）。 */
export const SCAN_INDICATOR_DELAY_MS = 300;

/**
 * `active` が SCAN_INDICATOR_DELAY_MS 以上継続したときだけ true を返す。
 * `active` が false になった瞬間は即 false（保留中タイマーは解除）。
 * Layer 1 ヒットや warm な瞬間再スキャンでバーが点滅するのを防ぐ。
 */
export function useScanIndicator(active: boolean): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), SCAN_INDICATOR_DELAY_MS);
    return () => clearTimeout(timer);
  }, [active]);

  return visible;
}
```

- [ ] **Step 4: テストを実行し成功を確認**

Run: `npx vitest run src/hooks/useScanIndicator.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: コミット**

```bash
git add src/hooks/useScanIndicator.ts src/hooks/useScanIndicator.test.ts
git commit -m "feat: スキャン中インジケータの遅延しきい値フック useScanIndicator"
```

---

### Task 2: `ScanProgressBar` コンポーネント（表示専用）

**Files:**
- Create: `src/components/ScanProgressBar.tsx`
- Test: `src/components/ScanProgressBar.test.tsx`

**Interfaces:**
- Consumes: `t("list.scanning")`（Task 3 で全ロケールへ追加。本タスクのテストは `t` をキー返しスタブでモックするため未追加でも通る）
- Produces: `export function ScanProgressBar(props: { visible: boolean }): JSX.Element`
  — 常に 2px トラック（`data-testid="scan-progress-track"`）を描画し、`visible` のとき内側に Fluent `ProgressBar`（非確定・`aria-label`）を描画。

- [ ] **Step 1: 失敗するテストを書く**

`src/components/ScanProgressBar.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScanProgressBar } from "./ScanProgressBar";

// t はキーをそのまま返すスタブ（App.test と同方針）
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("ScanProgressBar", () => {
  it("visible=true で progressbar を aria-label 付きで描画する", () => {
    render(<ScanProgressBar visible={true} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveAttribute("aria-label", "list.scanning");
  });

  it("visible=false ではトラックのみで progressbar を描画しない（レイアウトシフト回避）", () => {
    render(<ScanProgressBar visible={false} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByTestId("scan-progress-track")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: テストを実行し失敗を確認**

Run: `npx vitest run src/components/ScanProgressBar.test.tsx`
Expected: FAIL（`ScanProgressBar` が存在しない）

- [ ] **Step 3: 最小実装を書く**

`src/components/ScanProgressBar.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { ProgressBar, makeStyles } from "@fluentui/react-components";

interface Props {
  visible: boolean;
}

const useStyles = makeStyles({
  // レイアウトシフト回避: 常に 2px のトラック高を確保し、idle 時は空（透明）にする
  track: {
    height: "2px",
  },
});

/**
 * 再スキャン中の非確定インジケータ（AppHeader 直下の細いバー）。表示専用。
 * value を渡さないため Fluent ProgressBar は非確定（indeterminate）として描画される。
 * visible=false でも 2px のトラックを保持し、出現/消滅でレイアウトが揺れないようにする。
 */
export function ScanProgressBar({ visible }: Props) {
  const styles = useStyles();
  const { t } = useTranslation();
  return (
    <div className={styles.track} data-testid="scan-progress-track">
      {visible && <ProgressBar aria-label={t("list.scanning")} />}
    </div>
  );
}
```

- [ ] **Step 4: テストを実行し成功を確認**

Run: `npx vitest run src/components/ScanProgressBar.test.tsx`
Expected: PASS（2 tests）

- [ ] **Step 5: コミット**

```bash
git add src/components/ScanProgressBar.tsx src/components/ScanProgressBar.test.tsx
git commit -m "feat: 非確定スキャンバー ScanProgressBar（表示専用・レイアウトシフト回避）"
```

---

### Task 3: i18n キー `list.scanning` を 6 ロケールへ追加 ＋ ドキュメント同期

**Files:**
- Modify: `src/locales/ja.json` / `src/locales/en.json` / `src/locales/zh-CN.json` / `src/locales/zh-TW.json` / `src/locales/ko.json` / `src/locales/ru.json`
- Modify: `docs/locale-customization.md`（キー一覧の同期）
- Test: `src/lib/i18n.test.ts`（各ロケールで `list.scanning` が引けることを追加）

**Interfaces:**
- Produces: 全ロケールで `t("list.scanning")` が非空文字列を返す。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/i18n.test.ts` の `describe("i18n", …)` 内、`it("list.count の補間が…")` の直後に追加:

```ts
  it.each([
    ["ja",    "スキャン中..."],
    ["en",    "Scanning..."],
    ["zh-CN", "扫描中..."],
    ["zh-TW", "掃描中..."],
    ["ko",    "스캔 중..."],
    ["ru",    "Сканирование..."],
  ])("%s で list.scanning が返る", async (lang, expected) => {
    await i18n.changeLanguage(lang);
    expect(i18n.t("list.scanning")).toBe(expected);
  });
```

- [ ] **Step 2: テストを実行し失敗を確認**

Run: `npx vitest run src/lib/i18n.test.ts`
Expected: FAIL（`list.scanning` が各ロケールで未定義＝キーがそのまま返り期待値と不一致）

- [ ] **Step 3: 各ロケールにキーを追加**

各 `src/locales/<lang>.json` で、既存の `"list.loading": …,` 行の直後に以下を 1 行追加する（フラットキー・末尾カンマに注意）:

- `ja.json`: `"list.scanning": "スキャン中...",`
- `en.json`: `"list.scanning": "Scanning...",`
- `zh-CN.json`: `"list.scanning": "扫描中...",`
- `zh-TW.json`: `"list.scanning": "掃描中...",`
- `ko.json`: `"list.scanning": "스캔 중...",`
- `ru.json`: `"list.scanning": "Сканирование...",`

- [ ] **Step 4: テストを実行し成功を確認**

Run: `npx vitest run src/lib/i18n.test.ts`
Expected: PASS（`list.scanning` の 6 ケース含む）

- [ ] **Step 5: ドキュメント同期**

`docs/locale-customization.md` のキー一覧（翻訳キーの表/リスト）に `list.scanning`（用途: スキャン中インジケータの aria-label）を追加する。既存の `list.*` キーが列挙されている箇所に合わせて 1 行加える。

- [ ] **Step 6: コミット**

```bash
git add src/locales/ja.json src/locales/en.json src/locales/zh-CN.json src/locales/zh-TW.json src/locales/ko.json src/locales/ru.json src/lib/i18n.test.ts docs/locale-customization.md
git commit -m "feat: i18n キー list.scanning を 6 ロケールへ追加（スキャンバー aria 用）"
```

---

### Task 4: `App.tsx` へ結線 ＋ 統合テスト ＋ 検証

**Files:**
- Modify: `src/App.tsx`（import 追加・`showScanBar` 導出・JSX に `<ScanProgressBar/>` 挿入）
- Test: `src/App.test.tsx`（loading×一覧あり→300ms後にバー表示 / 初回（一覧なし）→非表示）

**Interfaces:**
- Consumes: `useScanIndicator`（Task 1）・`ScanProgressBar`（Task 2）・既存 `App.tsx` の `ghostsLoading`・`hasCachedDisplay`（`App.tsx:162`）。

- [ ] **Step 1: 失敗するテストを書く**

`src/App.test.tsx` の import に `screen` を追加（`import { render, act, screen } from "@testing-library/react";`）。ファイル末尾（最後の `describe` の後）に追加:

```tsx
describe("App - スキャン中インジケータ（再スキャン時のみ）", () => {
  it("再スキャン中（loading かつ 一覧あり）は 300ms 後に scan バーを表示する", () => {
    vi.useFakeTimers();
    try {
      mocks.ghostsState = { loading: true, error: null, refresh: () => {} };
      mocks.searchState = {
        ghosts: [makeGhost("Reimu")],
        total: 1,
        loadedStart: 0,
        loading: false,
        dbError: null,
      };
      render(<App />);
      // 300ms 未満は出ない（ちらつき防止）
      expect(screen.queryByRole("progressbar")).toBeNull();
      act(() => { vi.advanceTimersByTime(300); });
      expect(screen.getByRole("progressbar")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("初回スキャン（一覧なし）では scan バーを出さない（全画面スピナーに委ねる）", () => {
    vi.useFakeTimers();
    try {
      mocks.ghostsState = { loading: true, error: null, refresh: () => {} };
      mocks.searchState = { ghosts: [], total: 0, loadedStart: 0, loading: false, dbError: null };
      render(<App />);
      act(() => { vi.advanceTimersByTime(300); });
      expect(screen.queryByRole("progressbar")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: テストを実行し失敗を確認**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL（`ScanProgressBar` 未結線＝progressbar が見つからない）

- [ ] **Step 3: App.tsx に結線する**

`src/App.tsx` の import ブロック（`import { GhostContent } …` 付近）に追加:

```tsx
import { useScanIndicator } from "./hooks/useScanIndicator";
import { ScanProgressBar } from "./components/ScanProgressBar";
```

`const scanError = hasCachedDisplay ? null : error;`（`App.tsx:163`）の直後、`if (settingsLoading) {` の**前**に追加（フックは早期 return より前で呼ぶ）:

```tsx
  // 再スキャン中（既に一覧が見えている状態）のみ非確定バーを出す。初回（一覧なし）は
  // 全画面スピナー（GhostList）に委ねるため hasCachedDisplay で排他にする。
  const showScanBar = useScanIndicator(ghostsLoading && hasCachedDisplay);
```

JSX の `<AppHeader … />` と `<GhostContent … />` の間（`App.tsx:181` 直後）に挿入:

```tsx
        <ScanProgressBar visible={showScanBar} />
```

- [ ] **Step 4: テストを実行し成功を確認**

Run: `npx vitest run src/App.test.tsx`
Expected: PASS（追加 2 tests 含め全 App テスト）

- [ ] **Step 5: 全体検証**

```bash
npm test
npm run build
npm run check:ui-guidelines
npm run test:ui-guidelines-check
```
Expected: すべて成功（新規テスト含む）。

- [ ] **Step 6: コミット**

```bash
git add src/App.tsx src/App.test.tsx
git commit -m "feat: 再スキャン中に非確定スキャンバーを表示（App 結線）"
```

- [ ] **Step 7: 手動検証（/verify 推奨・任意）**

`npm run tauri dev` で起動し、一覧表示後に「再読込」またはフォルダ追加で再スキャンを発火し、cold・大量フォルダで上部バーが現れること、warm な瞬間再スキャンでは点滅しないこと、一覧が覆われず操作できることを目視確認する。UI ガイドライン準拠は `ux-reviewer` サブエージェントで確認してもよい。

---

## Self-Review

- **Spec coverage**: §3 上部バー→Task 2/4、§4 コンポーネント（useScanIndicator/ScanProgressBar/App 結線）→Task 1/2/4、§5 可視条件＋しきい値→Task 1/4、§6 レイアウトシフト回避（2px トラック）→Task 2、§7 a11y（aria-label・aria-busy なし）＋i18n（6 ロケール）→Task 2/3、§8 テスト→各タスク。カバー漏れなし。
- **Placeholder scan**: 「適切に」等の曖昧表現なし。全ステップに実コード/実コマンド。
- **Type consistency**: `useScanIndicator(active: boolean): boolean`（Task 1）と App の `useScanIndicator(ghostsLoading && hasCachedDisplay)`（Task 4）一致。`ScanProgressBar({ visible })`（Task 2）と `<ScanProgressBar visible={showScanBar} />`（Task 4）一致。`SCAN_INDICATOR_DELAY_MS=300` と App テストの `advanceTimersByTime(300)` 一致。`list.scanning`（Task 2 aria / Task 3 定義）一致。
