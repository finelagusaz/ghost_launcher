# 次アクション実行計画

作成日: 2026-02-25
前提: workspace/next_action.md の内容を精査し、実行可能性を評価した結果

---

## 実行可能性の評価

next_action.md に挙げられた各アクションを「今すぐ実行可能」「ユーザー対応が必要」「将来条件付き」の3層に分類する。

| # | アクション | 分類 | 根拠 |
|---|---|---|---|
| A | PR #16 マージ | **CI 通過後すぐ** | `gh pr merge` で完結。現在 CI pending 中 |
| B | CLAUDE.md 作業フロー改訂 | **今すぐ実行可能** | ファイル編集のみ |
| C | ghostCacheRepository.test.ts リファクタリング | **今すぐ実行可能** | 冗長な二重初期化を削除するだけ |
| D | Fix-F（script-src 実機確認） | **ユーザー対応必要** | `npm run tauri dev` で GUI を起動する必要あり |
| E | 改善後の開発フロー適用 | **将来タスク時** | プロセス変更。次の開発タスク開始時から自動適用 |
| F | ssp.exe チェックの抽出 | **将来条件付き** | 3箇所目が追加されたタイミングで実施 |

---

## A: PR #16 マージ

**現状:** CI が pending 中（`gh pr checks 16` で確認済み）。

**実施手順:**

```bash
# CI 通過を確認してからマージ
gh pr checks 16

# 全ステップ pass になったらマージ
gh pr merge 16 --merge --delete-branch
```

`--delete-branch` を付けることで GitHub Flow に従いブランチを削除する。

**確認すべき CI ステップ:**

| ステップ | 期待結果 |
|---|---|
| Build frontend (`tsc && vite build`) | pass（tsconfig.json exclude 追加済み）|
| Run frontend tests (`npm test`) | pass（21件）|
| Check UI guidelines | pass |
| Test UI guideline checks | pass |
| Test Rust crate (`cargo test`) | pass（7件）|

---

## B: CLAUDE.md 作業フロー改訂

**現状:** 5ステップ構成。「コミット」と「テスト基盤の整合確認」が独立したステップとして存在しない。

**変更内容:**

作業フロー（82〜88行）を以下に置き換える：

```markdown
## 作業フロー

1. **作業内容を明確にする** — 要件や目的を確認し、不明点があればユーザーに質問する
2. **調査する** — 関連する既存コード・パターン・依存関係を調べ、影響範囲を把握する。
   CI ワークフロー（`.github/workflows/ci-build.yml`）を読み、変更が CI で正しく検証されるか確認する
3. **テストを実装する** — 期待する振る舞いをテストコードとして先に書く
4. **テストがパスするように実装する** — テストを満たす最小限のコードを書く
5. **コミットする** — 実装完了 = コミット済み。`git status` が clean になるまでセッションを終了しない
6. **検証する** — `npm run build`・`npm test`・`cargo test` の全てが通ることを確認する
7. **PR を作成する** — CI が通ることを確認し、GitHub Flow に従い PR を作成する
```

さらに「コミット前チェックリスト」セクションを新設し、ブランチ戦略セクションの直前に挿入する：

```markdown
## コミット前チェックリスト

- [ ] `git status` が "nothing to commit, working tree clean" になっている
- [ ] `npm run build` が通る
- [ ] `npm test` が通る（テストがある場合）
- [ ] `cargo test` が通る（Rust を変更した場合）
- [ ] 新規テストファイルを追加した場合:
  - CI ワークフローでそのテストが実行されるか（`ci-build.yml` に test ステップが存在するか）
  - `tsconfig.json` の `exclude` に追加が必要か
  - `vitest.config.ts` の `include` が検出するか
```

**実施方法:** `refactor/` または `docs/` プレフィックスのブランチで CLAUDE.md を編集しコミット・PR。

---

## C: ghostCacheRepository.test.ts リファクタリング

**現状:** 「10件以内では削除しない」テストが途中で `resetSettingsStore()` を再度呼び出している。

```typescript
// 現状（78〜107行）: 10件を仕込んで write → 途中で気づいて reset → 9件でやり直し
it("10件以内では削除しない", async () => {
  // 10件をセット（実際にはこれで pruning が走り key-0 が削除されるため意図しない）
  const entries = ...;
  await settingsStore.set(...);
  await writeGhostCacheEntry("key-new", newest);

  // ← ここで「10件 + 1件 = 11件になる」ことに気づき、セットアップをやり直している
  resetSettingsStore();
  vi.clearAllMocks();
  const entries9 = ...; // 9件で再仕込み
  await settingsStore.set(...);
  await writeGhostCacheEntry("key-new", newest);

  const survived = await readGhostCacheEntry("key-0");
  expect(survived).toBeDefined();
});
```

**修正後:**

```typescript
it("10件以内では削除しない", async () => {
  // 9件 + 1件追加 = ちょうど上限。pruning が走らない
  const entries: Record<string, GhostCacheEntry> = {};
  for (let i = 0; i < 9; i++) {
    entries[`key-${i}`] = makeEntry(new Date(2026, 0, i + 1).toISOString());
  }
  await settingsStore.set(GHOST_CACHE_KEY, { version: 1, entries });

  const newest = makeEntry(new Date("2026-02-01T00:00:00Z").toISOString());
  await writeGhostCacheEntry("key-new", newest);

  // 9 + 1 = 10件でちょうど上限。key-0 は削除されないはず
  const survived = await readGhostCacheEntry("key-0");
  expect(survived).toBeDefined();
});
```

**実施方法:** `refactor/{issue番号}-cache-test-cleanup` ブランチで変更・テスト確認・PR。

---

## D: Fix-F（script-src 'unsafe-inline' 実機確認）

**実施者:** ユーザー（GUI 環境が必要）

**手順:**

```bash
npm run tauri dev
```

アプリ起動後:
1. WebView の開発者ツールを開く（F12 または右クリック→検証）
2. Console タブで CSP 関連のエラー（`Content Security Policy violation`）がないことを確認
3. 設定パネルを開く・閉じる・フォルダ選択をキャンセルするなど一通り操作する

**結果に応じた対応:**

| 確認結果 | 対応 |
|---|---|
| `script-src` 関連 CSP エラーが出ない | `tauri.conf.json` から `script-src` の `'unsafe-inline'` を削除して再確認 |
| `script-src` 関連 CSP エラーが出る | `'unsafe-inline'` を維持。コメントに「Tauri 2 インジェクトスクリプトに必要」と記録 |

---

## E・F: 将来タスク時に適用するプロセス変更

アクションとして実施するものではなく、次の開発タスク開始時点から自動的に適用する。

**E: 改善後の開発フロー**
next_action.md §「改善後の開発フロー（提案）」の [1]〜[10] を次のタスクから適用する。

**F: ssp.exe チェックの抽出**
`src-tauri/src/commands/ssp.rs` に ssp.exe 存在確認が現在2箇所ある。3箇所目が追加されたタイミングで `resolve_ssp_exe` ヘルパーに抽出する（CLAUDE.md 方針「3回目で抽出」）。

---

## 実施順序と依存関係

```
A: PR #16 マージ（CI 通過を待って実施）
    │
    ├─► B: CLAUDE.md 作業フロー改訂
    │       └─ 新規ブランチ: docs/{issue番号}-update-workflow
    │
    ├─► C: test.ts リファクタリング
    │       └─ 新規ブランチ: refactor/{issue番号}-cache-test-cleanup
    │
    └─► D: Fix-F 実機確認（ユーザー実施）
            └─ 結果によっては tauri.conf.json を変更する追加タスクが発生
```

B・C・D は A に依存しない（独立して着手可能）が、A が完了した clean な main から派生させることで GitHub Flow に準拠する。

---

## 優先順位サマリー

| 優先 | アクション | 担当 | ブランチ |
|---|---|---|---|
| 1 | **A**: PR #16 CI 確認 → マージ | Claude | fix/15 → main |
| 2 | **D**: Fix-F 実機確認 | ユーザー | なし（コード変更なし） |
| 3 | **B**: CLAUDE.md 作業フロー改訂 | Claude | `docs/{issue}-update-workflow` |
| 4 | **C**: test.ts リファクタリング | Claude | `refactor/{issue}-cache-test-cleanup` |
| 5 | **E**: 改善後の開発フロー適用 | 両者 | 次の開発タスクから |
| 6 | **F**: ssp.exe 抽出 | Claude | 3箇所目が追加されたとき |
