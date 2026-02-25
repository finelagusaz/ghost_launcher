# CI エラー調査レポート

調査日: 2026-02-25
対象: PR #16（fix/15ブランチ）の "Build frontend" ステップ

---

## エラー内容

```
Build frontend
Run npm run build

> ghost-launcher@0.1.0 build
> tsc && vite build

Error: src/lib/ghostCacheRepository.test.ts(1,54): error TS2307:
  Cannot find module 'vitest' or its corresponding type declarations.
Error: Process completed with exit code 1.
```

---

## 根本原因

### 直接原因

`npm run build` は `tsc && vite build` を実行する。`tsc` は `tsconfig.json` に従い型チェックを行うが、`tsconfig.json` の `"include": ["src"]` により `src/` 以下の**全 TypeScript ファイル**（テストファイルを含む）が対象になる。

テストファイル（`ghostCacheRepository.test.ts` 等）が `import ... from "vitest"` を使っているため、`tsc` が vitest モジュールを解決しようとして失敗する。

```json
// tsconfig.json（現状）
{
  "include": ["src"]  // src/**/*.test.ts も対象に含まれてしまう
}
```

### なぜ vitest の型が解決できないか

`npm test`（vitest run）ではなく `tsc` が直接 vitest パッケージを解決しようとするとき、以下の違いが生じる。

| 実行コマンド | モジュール解決主体 | vitest の型解決 |
|---|---|---|
| `npm test` | vitest（自己認識） | 問題なし |
| `tsc`（`npm run build`内） | TypeScript compiler（標準解決） | 失敗する場合がある |

`vitest` はインストール済み（`package.json` devDependencies に `"vitest": "^3.2.4"`）だが、`tsconfig.json` の `"moduleResolution": "bundler"` + CI 環境の組み合わせで解決に失敗している。

### ローカルで再現しない理由（推定）

ローカルでは `npm run build` 実行時に、fix/15 ブランチの変更に加えて PR-1〜PR-6 のローカル未コミット変更（テスト環境設定ファイルを含む）も存在していたため、環境状態が CI と異なっていた可能性が高い。CI は push されたコミット内容のみを使用するため差異が生じた。

---

## 影響ファイル

| ファイル | 問題 |
|---|---|
| `tsconfig.json` | `"include": ["src"]` がテストファイルを含む |
| `src/lib/ghostCacheRepository.test.ts` | `from "vitest"` のインポート（Fix-C で追加） |
| `src/lib/ghostScanUtils.test.ts` | 同上（PR-1〜6 で追加） |
| `src/hooks/useSearch.test.ts` | 同上（PR-1〜6 で追加） |
| `src/test/setup.ts` | 同上（PR-1〜6 で追加） |

---

## 対応方針

### 採用案: `tsconfig.json` にテストファイルの `exclude` を追加

これが Vite + Vitest プロジェクトの標準パターン。`tsc`（プロダクションビルド用）とテスト用型チェックを明示的に分離する。

```json
// tsconfig.json
{
  "compilerOptions": { ... },
  "include": ["src"],
  "exclude": [
    "src/**/*.test.ts",
    "src/**/*.test.tsx",
    "src/test"
  ],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

**影響分析:**

- `npm run build`（`tsc`）: テストファイルを型チェック対象から除外 → エラー解消
- `npm test`（vitest）: vitest は `tsconfig.json` の `exclude` を**参照しない**。`vitest.config.ts` の `include: ["src/**/*.test.{ts,tsx}"]` に従い動作する → 既存21件のテストに影響なし
- テストファイル自体の型安全性: vitest が自前でテストファイルをトランスパイルするため、vitest のインクルード設定が効いている限り型チェックは継続される

### 採用しない代替案

| 案 | 不採用理由 |
|---|---|
| `tsconfig.json` に `"types": ["vitest"]` を追加 | プロダクションコードに vitest のグローバル型が混入する。globals: false の方針と矛盾 |
| `tsconfig.test.json` を新設して vitest に参照させる | 追加ファイルが増える。exclude で十分であり YAGNI に反する |
| テストファイルで `/// <reference types="vitest" />` を追記 | 全テストファイルに追記が必要。本質的な解決でない |

---

## 変更内容（fix/15 に追加コミット）

### `tsconfig.json` に `exclude` を追加

```diff
  {
    "compilerOptions": { ... },
    "include": ["src"],
+   "exclude": [
+     "src/**/*.test.ts",
+     "src/**/*.test.tsx",
+     "src/test"
+   ],
    "references": [{ "path": "./tsconfig.node.json" }]
  }
```

### 検証手順

```bash
npm run build  # tsc + vite build が通ることを確認
npm test       # 既存21件のテストが引き続き通ることを確認
```

---

## 関連する未コミット変更について

fix/15 ブランチ作成時、PR-1〜6 の変更（`ghostScanUtils.test.ts`, `useSearch.test.ts`, `src/test/` 以下のモックファイル等）がローカルに残っているが fix/15 ブランチには含まれていない。

この状態でも `npm run build` の修正（`tsconfig.json` exclude 追加）だけで CI は通る。ただし fix/15 のテスト基盤が完全でない状態のため、**PR-1〜6 の変更も fix/15 に含めることを推奨する**（別途対応を検討）。
