# スキル体系再設計 実装計画（issue #99）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** サイクル系 4 スキル・検証系 4 スキルを新設し、既存 `/commit` `/pr` を修正し、CLAUDE.md をポインタ化する。

**Architecture:** `.claude/skills/<name>/SKILL.md` にスキルを 1 本ずつ追加する。各スキルは既存スキル（commit/pr/e2e/post-merge-sync）の文体（frontmatter + 見出し + ステップ + 注意事項）を踏襲する。CLAUDE.md の「作業フロー」「コミット前チェックリスト」節は最後にポインタ化する（スキルが全部揃ってから）。

**Tech Stack:** Markdown のみ。コード変更なし。

**Spec:** `docs/superpowers/specs/2026-07-04-skills-redesign-design.md`

## Global Constraints

- 作業ブランチ: `refactor/99-skills-redesign`（作成済み。設計ドキュメントのコミット `fd36be5` を含む）
- すべて日本語で書く（このプロジェクトの UI・ドキュメント言語）
- ドキュメントのみの変更のため Red テストは書けない。各コミットメッセージに「スキル定義のみの追加/変更のためテストは書かない」旨を明記する
- コミットメッセージ末尾にハーネス既定の Co-Authored-By 行を付与する
- frontmatter の `name` はディレクトリ名と完全一致させる
- `description` には発火トリガー（ユーザーの言い回し・変更領域）を必ず含める
- 手動専用スキル（`/health-check` `/retrospective` `/deps-update` `/e2e` `/post-merge-sync`）には `disable-model-invocation: true` を付ける
- モデル名・バージョン番号など時間経過で陳腐化する値をスキル本文にハードコードしない

---

### Task 1: `/implement` スキル新設

**Files:**
- Create: `.claude/skills/implement/SKILL.md`

**Interfaces:**
- Consumes: なし
- Produces: スキル名 `/implement`（Task 11 の CLAUDE.md 一覧表、`/start-issue` の接続先が参照する）。検証フェーズの条件発火表が `/ipc-check` `/symmetry-check` `/cache-check` `/e2e` を名前で参照する（Task 5-8 で作成されるが、スキル間参照は名前のみなので先行作成してよい）

- [ ] **Step 1: SKILL.md を作成する**

````markdown
---
name: implement
description: コード変更（機能追加・バグ修正・リファクタリング）のフルサイクルを実行する。ユーザーが「実装して」「直して」「対応して」等のコード変更を依頼したとき、または「/implement」と言ったときに使う。調査→テスト先行→実装→検証→コミットの順で進め、変更領域に応じた検証スキルを条件発火する。
---

# 実装フルサイクル

コード変更を調査からコミットまで一気通貫で進めるワークフロー。CLAUDE.md の開発方針（KISS/DRY/SRP/YAGNI）とデバッグ原則は常に前提とする。

## ステップ 1: 明確化

- 要件・目的の不明点があれば、作業を始める前にまとめて質問する
- 複数ファイルにまたがる大きな機能追加・リファクタリングは plan モードで設計を先に提示し、承認後に実装へ入る

## ステップ 2: ブランチ確認

- `git status` が clean であることを確認する
- main 上にいる場合は `{prefix}/{issue番号}-{英語で内容の説明}` の作業ブランチを先に切る（プレフィックス: `feature/` `fix/` `hotfix/` `release/` `test/` `docs/` `refactor/`）
- issue 起点の作業なら `/start-issue` の利用を案内する

## ステップ 3: 調査

- 関連する関数の使用箇所を検索し、影響範囲を確認する
- 対称的なコードパス（追加/削除、成功/失敗）がある場合は両方を確認する
- 変更しないと判断したファイルについても、その根拠を確認する
- `.github/workflows/ci-build.yml` を読み、変更が CI で正しく検証されるか確認する

## ステップ 4: テストを先に書く（Red）

- 期待する振る舞いをテストコードとして先に書き、失敗することを確認する
- テストの種類と置き場: フック → `renderHook`（`src/hooks/*.test.ts`）、ライブラリ → 純粋関数（`src/lib/*.test.ts`）、コンポーネント → `render` + jsdom（`src/components/*.test.tsx`）
- 削除リファクタリングは Red が書けないため、「削除対象の本番使用ゼロ」を grep で前提検証し、期待外のヒットが出たら中止する
- ドキュメント更新や CI 設定変更などテスト追加が不適切な作業は、理由をコミットメッセージまたは PR 説明に明記する
- 新規テストファイルを追加した場合: `ci-build.yml` で実行されるか・`tsconfig.json` の `exclude` に追加が必要か・`vitest.config.ts` の `include` が検出するかを確認する

## ステップ 5: 実装（Green）

- テストを満たす最小限のコードを書き、テストが通ることを確認する

## ステップ 6: 検証フェーズ（条件発火）

変更が触れた領域に応じて、該当する検証スキルを実行する（複数該当なら複数実行）:

| 変更が触れた領域 | 発火するスキル |
|---|---|
| `src-tauri/src/commands/`・invoke ラッパー（`src/lib/`）・`src/types/generated/` | `/ipc-check` |
| 既存関数のコピー改変、追加/削除・成功/失敗の対称ペア | `/symmetry-check` |
| キャッシュ・fingerprint・request_key・DB スキーマ | `/cache-check` |
| UI 操作・言語表示・フォーム | E2E 手動実行の要否を判断し `/e2e` を案内（E2E は CI に含まれず、手動確認が唯一の統合テスト手段） |

どの領域にも該当しない場合はその旨を報告して次へ進む。

## ステップ 7: 締め

- SPEC.md に影響する振る舞い変更は、同一コミットで SPEC.md も更新する
- `/commit` へ接続する（チェックリストの実行とコミットは `/commit` の責務）

## 注意事項

- コミットの実処理は `/commit`、PR 作成は `/pr` に委譲する。手順をこのスキルに重複記載しない
- 修正後に症状が別のテストへ移動した場合は根本原因に未達のサイン。同一パターンのバグを検索してから完了とする
````

- [ ] **Step 2: 検証する**

以下を確認する:
- `.claude/skills/implement/SKILL.md` が存在し、frontmatter の `name: implement` がディレクトリ名と一致している
- 本文中の参照先が実在する: `/start-issue` `/ipc-check` `/symmetry-check` `/cache-check` は本計画内で作成予定（名前参照のみで OK）、`/commit` `/pr` `/e2e` は既存（`.claude/skills/` に存在すること）
- 本文中のファイルパス `ci-build.yml` / `tsconfig.json` / `vitest.config.ts` がリポジトリに実在すること

- [ ] **Step 3: コミット**

```powershell
git add .claude/skills/implement/SKILL.md
git commit -m "feat: /implement スキルを新設し作業フローを移植 (#99)

CLAUDE.md の作業フロー 7 ステップをスキル化し、変更領域に応じた
検証スキルの条件発火表を導入。スキル定義のみの追加のためテストは書かない。"
```

---

### Task 2: `/start-issue` スキル新設

**Files:**
- Create: `.claude/skills/start-issue/SKILL.md`

**Interfaces:**
- Consumes: `/implement`（Task 1、接続先として名前参照）
- Produces: スキル名 `/start-issue`

- [ ] **Step 1: SKILL.md を作成する**

````markdown
---
name: start-issue
description: GitHub issue への着手を定型化するプリステップ。ユーザーが「issue #N に着手」「issue #N やって」「/start-issue N」と言ったときに使う。issue 確認→clean 確認→main 最新化→ブランチ作成→調査・方針提示まで行う。
---

# issue 着手ワークフロー

GitHub issue を起点に、実装に入る直前までの準備を定型化する。

## 引数

- `$ARGUMENTS` に issue 番号（例: `99`）。無ければユーザーに確認する。

## ステップ 1: issue の把握

```bash
gh issue view <N>
```

タイトル・本文・ラベル・関連 issue を読み、要求を把握する。不明点があればユーザーに質問してから進む。

## ステップ 2: 作業ツリーの確認

`git status` が "nothing to commit, working tree clean" であることを確認する。未コミット変更がある場合は中断し、ユーザーに退避（コミット or stash）を確認する。

## ステップ 3: main の最新化（gh-HTTPS）

> この環境は SSH push/fetch が壊れているため、`/post-merge-sync` と同方式の gh-HTTPS で迂回する。

```bash
git switch main
git -c credential.helper= -c credential.helper='!gh auth git-credential' \
  pull https://github.com/finelagusaz/ghost_launcher.git main --ff-only
git update-ref refs/remotes/origin/main "$(git rev-parse main)"
```

## ステップ 4: ブランチ作成

命名規則 `{prefix}/{issue番号}-{英語で内容の説明}` に従う（番号のみは不可）:

```bash
git switch -c <prefix>/<N>-<english-description>
```

プレフィックスは issue の性質から選ぶ: `feature/` `fix/` `hotfix/` `release/` `test/` `docs/` `refactor/`

## ステップ 5: 調査と方針提示

- issue の要求に関連するコード・SPEC.md の該当節を調査する
- 着手方針（変更対象ファイル・影響範囲・テスト方針）を短くまとめてユーザーに提示する
- 大きな変更なら plan モードでの設計提示を提案する

## ステップ 6: 実装へ

`/implement` へ接続する（調査結果を引き継ぎ、ステップ 3 の調査から再開してよい）。
````

- [ ] **Step 2: 検証する**

- frontmatter の `name: start-issue` がディレクトリ名と一致していること
- gh-HTTPS のコマンドが `.claude/skills/post-merge-sync/SKILL.md` のステップ 3-4 と同一であること（`git -c credential.helper=` 行と `update-ref` 行を目視比較）
- ブランチ命名規則が CLAUDE.md「ブランチ命名規則」節と一致していること

- [ ] **Step 3: コミット**

```powershell
git add .claude/skills/start-issue/SKILL.md
git commit -m "feat: /start-issue スキルを新設し issue 着手を定型化 (#99)

issue 確認から作業ブランチ作成・調査方針提示までのプリステップ。
main 最新化はこの環境の制約に合わせ gh-HTTPS 迂回で行う。
スキル定義のみの追加のためテストは書かない。"
```

---

### Task 3: `/retrospective` スキル新設

**Files:**
- Create: `.claude/skills/retrospective/SKILL.md`

**Interfaces:**
- Consumes: なし
- Produces: スキル名 `/retrospective`

- [ ] **Step 1: SKILL.md を作成する**

````markdown
---
name: retrospective
description: サイクル終了後の振り返りを定型化する。ユーザーが「振り返りして」「レトロスペクティブ」「/retrospective」と言ったときに使う。教訓を先にドキュメントへ抽出してから RETROSPECTIVE.md を上書きする（抽出前の上書き禁止）。
disable-model-invocation: true
---

# 振り返りワークフロー

サイクル（実装・レビュー・追加修正まで完了）の締めとして、教訓を抽出し RETROSPECTIVE.md を更新する。

> **不変条件**: RETROSPECTIVE.md は上書き運用のため、教訓の抽出前に上書きすると前サイクルの教訓が失われる。必ず「抽出 → コミット → 上書き」の順で行う。

## ステップ 1: 教訓の列挙

今サイクルの作業（コミット履歴・レビュー指摘・デバッグ過程）を振り返り、以下を列挙する:

- よかったこと（再現したいパターン）
- 伸びしろ（防げたはずの手戻り・見逃し）
- 各項目について「なぜそうなったか」の根本要因

## ステップ 2: 教訓の行き先判定

列挙した教訓ひとつずつに行き先を決める:

| 行き先 | 基準 |
|---|---|
| ルート CLAUDE.md | 全作業に常時効く判断基準・規約 |
| フォルダ CLAUDE.md（`src/` `src-tauri/` `e2e/`） | そのフォルダの作業でだけ効く知識 |
| 該当スキル（`.claude/skills/*/SKILL.md`） | 特定ワークフローの手順改善 |
| どこにも入れない | 一度きりの事象で再発可能性が低いもの |

「短さが正義」「1 in 1 out」を意識し、追加するなら不要になったルールの削除も検討する。

## ステップ 3: 抽出を先にコミット

行き先が決まった教訓をドキュメントへ反映し、**RETROSPECTIVE.md に触れる前に**コミットする。

## ステップ 4: RETROSPECTIVE.md の上書き

前サイクルの内容を新サイクルの振り返りで置き換える（追記しない）。構成:

- サイクル名（何をしたサイクルか）
- 何をしたか
- よかったこと
- 伸びしろ
- ネクストアクション

## ステップ 5: ネクストアクションの issue 化提案

ネクストアクションのうち追跡すべきものを `gh issue create` で起票することを提案する（起票はユーザー確認後）。

## ステップ 6: コミット

RETROSPECTIVE.md の上書きをコミットする。
````

- [ ] **Step 2: 検証する**

- frontmatter に `disable-model-invocation: true` があること
- 手順が CLAUDE.md「参照ドキュメント」節の RETROSPECTIVE.md 更新手順（抽出 → 上書き）と矛盾しないこと

- [ ] **Step 3: コミット**

```powershell
git add .claude/skills/retrospective/SKILL.md
git commit -m "feat: /retrospective スキルを新設し振り返り手順を強制 (#99)

教訓抽出→コミット→RETROSPECTIVE.md 上書きの順序を手順として固定し、
抽出前上書きによる教訓喪失を防ぐ。スキル定義のみの追加のためテストは書かない。"
```

---

### Task 4: `/deps-update` スキル新設

**Files:**
- Create: `.claude/skills/deps-update/SKILL.md`

**Interfaces:**
- Consumes: `/commit` `/pr` `/e2e`（既存、接続先として名前参照）
- Produces: スキル名 `/deps-update`

- [ ] **Step 1: SKILL.md を作成する**

````markdown
---
name: deps-update
description: cargo/npm の依存を一括更新し検証する。ユーザーが「依存更新して」「deps 更新」「/deps-update」と言ったときに使う。メジャー更新の個別判断と tauri 系の版揃え・links 制約を踏まえる。
disable-model-invocation: true
---

# 依存更新ワークフロー

npm と cargo の依存を安全に更新する。

## ステップ 1: 現状把握

以下を並列で実行する:

```bash
npm outdated
cargo update --dry-run
```

## ステップ 2: 更新方針の判断

- **パッチ・マイナー更新**: 一括で進めてよい
- **メジャー更新**: 1 件ずつ changelog・breaking changes を確認し、ユーザーに更新可否を確認する
- **tauri 系**（`@tauri-apps/cli` / `@tauri-apps/api` / 各プラグイン / `tauri` クレート）: CLI・api・プラグインの版を揃える
- **rusqlite / libsqlite3-sys**: `tauri-plugin-sql` との links 制約で上限が固定されている。`src-tauri/CLAUDE.md`「rusqlite と sqlx-sqlite の libsqlite3-sys 共有制約」を読み、解錠条件を満たしていない限り major bump しない
- **シリアライズ・ストレージ形式に関わるクレート**: 後方互換性の検証手順（`src-tauri/CLAUDE.md`「依存クレートの移行・更新」）に従う

## ステップ 3: 更新の実行

```bash
npm update          # package.json の semver 範囲内
cargo update        # Cargo.lock の更新
```

範囲を超える更新（メジャー）は `package.json` / `Cargo.toml` を個別に編集する。

## ステップ 4: 検証

`/commit` のコミット前チェックリストを全実行する。UI に波及しうる更新（React・Fluent UI・i18next・tauri 系）の場合は `/e2e` の手動実行を推奨する。

## ステップ 5: コミットと PR

`/commit` → `/pr` へ接続する。更新内容（何をどの版からどの版へ）を PR 本文に列挙する。
````

- [ ] **Step 2: 検証する**

- frontmatter に `disable-model-invocation: true` があること
- 参照している `src-tauri/CLAUDE.md` の節名 2 つ（「rusqlite と sqlx-sqlite の libsqlite3-sys 共有制約」「依存クレートの移行・更新」）が実在すること（grep で確認）

- [ ] **Step 3: コミット**

```powershell
git add .claude/skills/deps-update/SKILL.md
git commit -m "feat: /deps-update スキルを新設し依存更新を定型化 (#99)

メジャー更新の個別判断・tauri 系の版揃え・libsqlite3-sys links 制約の
参照を手順化。スキル定義のみの追加のためテストは書かない。"
```

---

### Task 5: `/ipc-check` スキル新設

**Files:**
- Create: `.claude/skills/ipc-check/SKILL.md`

**Interfaces:**
- Consumes: `ipc-boundary-checker` サブエージェント（既存、`.claude/agents/`）
- Produces: スキル名 `/ipc-check`（`/implement` の条件発火表が参照）

- [ ] **Step 1: SKILL.md を作成する**

````markdown
---
name: ipc-check
description: Tauri IPC 境界（Rust↔TS）の契約を検証する。src-tauri/src/commands/ 配下・invoke ラッパー（src/lib/）・src/types/generated/ に触れる変更をしたとき、または「/ipc-check」と言われたときに使う。生成型の同期・命名変換の非対称・セマンティクス変更・テストモック契約を監査する。
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

戻り値の「空・省略・null」の意味を変えた変更（例: `cache_hit=true` のとき `ghosts: []` を「0 件」でなく「省略」の意味で返す）では:

1. その戻り値を受け取る**全コードパス**を検索して列挙する
2. 各受け手が新しい意味で正しく解釈するか確認する

型シグネチャが同じままの意味変更はコンパイラで検知できない。過去にこのパターンで DB 全削除バグが発生している。

## 検査 4: テストモック契約監査

`invoke` をモックするテストについて:

1. モックの戻り値が Rust 側の実装で**実際に発生しうる組み合わせ**か確認する（例: `cache_hit=true` なら Rust は必ず `ghosts: []` を返す。`cache_hit: true, ghosts: [1件]` は現実に発生しない）
2. 発生しない組み合わせを返すモックは、本物のバグを検知できない無意味テスト。実契約に合わせて修正する

## サブエージェント委譲

変更が複数コマンドにまたがる・IPC struct の増減があるなど大きい場合は、`ipc-boundary-checker` サブエージェントに検査を委譲し、このスキルは検査観点の指定と結果の判定に徹する。

## 出力

検査 1〜4 それぞれについて ✅（問題なし）/ ⚠️（要修正、根拠 file:line 付き）を報告する。
````

- [ ] **Step 2: 検証する**

- 検査 1 の記述が `src-tauri/CLAUDE.md`「IPC 型の管理」節と整合すること（ts-rs 生成の仕組み・戻り値フィールド名のルール）
- `ipc-boundary-checker` サブエージェントが `.claude/agents/` に実在すること
- CI ステップ名「Verify generated types are committed」が `.github/workflows/ci-build.yml` に実在すること

- [ ] **Step 3: コミット**

```powershell
git add .claude/skills/ipc-check/SKILL.md
git commit -m "feat: /ipc-check スキルを新設し IPC 契約検証を手順化 (#99)

生成型同期・命名変換の非対称・セマンティクス変更・モック契約の 4 検査。
cache_hit=true→ghosts:[] 全削除バグの再発防止（RETROSPECTIVE 教訓）。
スキル定義のみの追加のためテストは書かない。"
```

---

### Task 6: `/symmetry-check` スキル新設

**Files:**
- Create: `.claude/skills/symmetry-check/SKILL.md`

**Interfaces:**
- Consumes: なし
- Produces: スキル名 `/symmetry-check`（`/implement` の条件発火表が参照）

- [ ] **Step 1: SKILL.md を作成する**

````markdown
---
name: symmetry-check
description: コード変更の対称性と DRY を検証する。既存関数をコピー改変したとき、追加/削除・成功/失敗などの対称ペアに触れたとき、または「/symmetry-check」と言われたときに使う。対称パスの適用漏れとコピー統合の可能性を検査する。
---

# 対称性・DRY 検証

変更が「片側だけ」になっていないか、同じロジックの重複を生んでいないかを検証する。

## 検査 1: 対称ペアの適用漏れ

1. 変更したコードに対称ペアがあるか列挙する: 追加/削除、成功/失敗、登録/解除、保存/読込、シリアライズ/デシリアライズ、マウント/アンマウント
2. ペアの片側だけ変更されていないか、もう片側を grep で特定して確認する
3. 片側だけの変更が意図的な場合は、その根拠を報告に含める

## 検査 2: コピー改変の検出

1. 今回の変更に「既存関数をコピーして改変した」コードがあるか確認する
2. ある場合、コピー元とパラメータ追加・クロージャ引数で**統合できないか**を先に検討する
3. 統合しない判断をする場合は理由を明示する（過去に `scan_parent_one_pass` と `push_parent_fingerprint_tokens` が同一走査ロジックのコピーとなりレビュー指摘を受けた）

## 検査 3: DRY 判定基準

- 同一ロジックの繰り返しは 2 回までは許容、3 回目で抽出を検討する（無理な抽象化よりも多少の重複を許容）
- 変更で「3 回目の重複」が生まれていないか検索する

## 検査 4: Rust/JS 二重実装の整合

Rust と JS の両側に同じロジックが存在する箇所（request_key の構成・ソート順・正規化など）に触れた場合:

1. 両側の実装を突き合わせ、仕様（順序・正規化方式・区切り文字）が一致しているか確認する
2. 特に文字列比較: JS の `localeCompare` と Rust の `cmp` は順序が異なる（`ghost2`/`ghost_dev` で逆転）。機械的キーの整列は両側とも**コードポイント順**に揃える

## 出力

検査 1〜4 それぞれについて ✅ / ⚠️（根拠 file:line 付き）を報告する。
````

- [ ] **Step 2: 検証する**

- frontmatter の `name: symmetry-check` がディレクトリ名と一致していること
- 検査 4 の localeCompare/cmp の記述が CLAUDE.md・メモリの既知教訓と整合すること（`request_key` のソートに関する既存の教訓）

- [ ] **Step 3: コミット**

```powershell
git add .claude/skills/symmetry-check/SKILL.md
git commit -m "feat: /symmetry-check スキルを新設し対称性・DRY 検証を手順化 (#99)

対称ペア適用漏れ・コピー統合検討・DRY 基準・Rust/JS 二重実装整合の
4 検査。Snotra の symmetric-check/dry-check を発火条件が同一のため
1 本に統合。スキル定義のみの追加のためテストは書かない。"
```

---

### Task 7: `/cache-check` スキル新設

**Files:**
- Create: `.claude/skills/cache-check/SKILL.md`

**Interfaces:**
- Consumes: なし
- Produces: スキル名 `/cache-check`（`/implement` の条件発火表が参照）

- [ ] **Step 1: SKILL.md を作成する**

````markdown
---
name: cache-check
description: キャッシュ・状態遷移の整合性を検証する。キャッシュ（localStorage/ghosts.db）・fingerprint・request_key・DB スキーマ・状態管理に触れる変更をしたとき、または「/cache-check」と言われたときに使う。2 層キャッシュの独立リセット耐性と揮発/永続分離を検査する。
---

# キャッシュ・状態整合検証

多層キャッシュと永続データの整合性が変更後も保たれているか検証する。

## 前提となる構造

- **ghosts.db** — 揮発キャッシュ（sqlx/tauri-plugin-sql 経由 + scan_and_store は rusqlite 直接）。マイグレーション競合時に**丸ごと削除**して回復する設計
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

## 検査 4: マイグレーション不変性

- 適用済み（コミット済み）マイグレーションの SQL 文字列に**一切の変更がないか** `git diff` で確認する（空白変更でもチェックサム不一致で起動不能）
- 新規マイグレーションの `DEFAULT` にリテラル以外（関数）を使っていないか
- 複数行 SQL が `\n` 明示で書かれているか（raw 改行 + インデント禁止）

## 検査 5: 状態遷移の到達可能性

新しい状態・フラグ・キャッシュキーを追加した場合:

- すべての遷移経路で初期値が定義されているか
- リセット経路（DB リセット・設定クリア・再スキャン）で新しい状態も正しく初期化されるか
- 到達不能な状態や、抜け出せない状態が生まれていないか

## 出力

検査 1〜5 それぞれについて ✅ / ⚠️（根拠 file:line 付き）を報告する。
````

- [ ] **Step 2: 検証する**

- 前提構造の記述が `src-tauri/CLAUDE.md`「SQLite」節（マイグレーション制約・不変性・cross-DB JOIN 不可・永続テーブル規約）と整合すること
- `SPEC.md` に §4.5 / §6.6 が実在すること（grep で確認）
- `record_launch` / `scan_and_store` が実在するコマンド名であること（`src-tauri/src/commands/` を grep）

- [ ] **Step 3: コミット**

```powershell
git add .claude/skills/cache-check/SKILL.md
git commit -m "feat: /cache-check スキルを新設しキャッシュ整合検証を手順化 (#99)

2 層キャッシュのリセット耐性・揮発/永続分離・集計列同期・
マイグレーション不変性・状態遷移の 5 検査。
スキル定義のみの追加のためテストは書かない。"
```

---

### Task 8: `/health-check` スキル新設

**Files:**
- Create: `.claude/skills/health-check/SKILL.md`

**Interfaces:**
- Consumes: なし
- Produces: スキル名 `/health-check`

- [ ] **Step 1: SKILL.md を作成する**

````markdown
---
name: health-check
description: ドキュメントと実装の整合性を定期検査する。ユーザーが「ヘルスチェック」「整合性チェック」「/health-check」と言ったとき、またはサイクル完了後の点検を頼まれたときに使う。検出のみで修正はしない（報告のみ）。
disable-model-invocation: true
---

# ドキュメント整合検査（報告のみ）

ドキュメント・スキル・CI と実装の乖離を検出して報告する。

> **絶対条件: 報告のみ。** このスキルの実行中はいかなるファイルも修正しない。修正はユーザーの優先度判断を経て、別途指示を受けてから行う（「ついで修正」の混入防止）。

## 検査項目

1. **SPEC.md と実装** — コマンド一覧・振る舞い・DB スキーマの記述が実装と一致するか（Tauri コマンドの増減、マイグレーション版数、ソート仕様などを突き合わせる）
2. **ルート CLAUDE.md** — 記載コマンドが実行可能か、ファイルパス・ディレクトリ構成図が実在と一致するか
3. **フォルダ CLAUDE.md**（`src/` `src-tauri/` `e2e/`）— 記述が現在のコードと一致するか、移動・消失したファイルへの言及がないか
4. **docs/** — `ui-guidelines.md`・`locale-customization.md` の規約が実装と一致するか
5. **スキルの化石検出** — 各 `.claude/skills/*/SKILL.md` 内のコマンド・パス・バージョン表記・モデル名が現在も有効か
6. **CI とチェックリスト** — `.github/workflows/ci-build.yml` のステップと `/commit` のチェックリストが整合するか（CI にあってローカルに無いチェック、またはその逆）
7. **生成型** — `src/types/generated/` にコミット漏れ・実装に対応しない孤児ファイルがないか（`cargo test --workspace` 後に `git status --porcelain src/types/generated/` で確認）
8. **RETROSPECTIVE.md** — ネクストアクションが issue 化または消化されているか（`gh issue list` と突き合わせる）

## 出力形式

| # | 検査項目 | 判定 | 根拠 |
|---|---|---|---|
| 1 | SPEC.md と実装 | ✅ / ⚠️ | file:line と乖離内容 |
| … | … | … | … |

⚠️ の項目には修正の当たり（どのファイルをどう直すべきか）を 1 行で添える。修正自体は行わない。
````

- [ ] **Step 2: 検証する**

- frontmatter に `disable-model-invocation: true` があること
- 検査対象パスがすべて実在すること: `SPEC.md`、`src/CLAUDE.md`、`src-tauri/CLAUDE.md`、`e2e/CLAUDE.md`、`docs/ui-guidelines.md`、`docs/locale-customization.md`、`src/types/generated/`、`RETROSPECTIVE.md`

- [ ] **Step 3: コミット**

```powershell
git add .claude/skills/health-check/SKILL.md
git commit -m "feat: /health-check スキルを新設しドキュメント整合検査を手順化 (#99)

SPEC/CLAUDE.md/docs/スキル/CI/生成型/振り返りの 8 項目を報告のみで検査。
検査と修正を分離し「ついで修正」の混入を防ぐ。
スキル定義のみの追加のためテストは書かない。"
```

---

### Task 9: `/commit` スキル修正

**Files:**
- Modify: `.claude/skills/commit/SKILL.md`

**Interfaces:**
- Consumes: なし
- Produces: 単一権威となるコミット前チェックリスト（Task 11 の CLAUDE.md ポインタが参照）

- [ ] **Step 1: チェックリストを CI と整合させる**

`.claude/skills/commit/SKILL.md` のステップ 2 を以下のとおり変更する。

変更前:

````markdown
以下を**可能な限り並列で**実行する:

```bash
# グループ A（並列実行）
npm run build
npm test
npm run check:ui-guidelines
npm run test:ui-guidelines-check

# グループ B（並列実行）
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path crates/ghost-meta/Cargo.toml
```

グループ A とグループ B は互いに独立しているため並列実行してよい。
````

変更後:

````markdown
以下を**可能な限り並列で**実行する:

```bash
# グループ A（並列実行）
npm run build
npm test
npm run check:ui-guidelines
npm run test:ui-guidelines-check

# グループ B（順次実行。CI の ci-build.yml と同一コマンド）
cargo test --workspace
cargo test -p ghost-meta --features thumbnail,serde
```

グループ A とグループ B は互いに独立しているため並列実行してよい（グループ B 内は target ディレクトリのロック競合を避けるため順次）。

### 追加の確認事項

- **新規テストファイルを追加した場合**: `ci-build.yml` で実行されるか・`tsconfig.json` の `exclude` に追加が必要か・`vitest.config.ts` の `include` が検出するかを確認する
- **UI 操作・言語表示・フォーム入力に関わる変更の場合**: E2E テスト（`/e2e`）の手動実行を済ませたか確認する（E2E は CI に含まれない）
- **IPC struct を変更した場合**: `cargo test --workspace` 後に `src/types/generated/` の差分をコミットに含める
````

- [ ] **Step 2: Co-Authored-By の化石を除去する**

同ファイルのステップ 3「コミットメッセージ」を以下のとおり変更する。

変更前:

````markdown
- **Co-Authored-By**: 末尾に `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>` を付与

```bash
git commit -m "$(cat <<'EOF'
prefix: コミットメッセージ

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```
````

変更後:

````markdown
- **Co-Authored-By**: 末尾にハーネス既定の Co-Authored-By 行を付与する（モデル名をこのスキルにハードコードしない。ハーネスの指示に従う）

```bash
git commit -m "$(cat <<'EOF'
prefix: コミットメッセージ

Co-Authored-By: <ハーネス既定の表記>
EOF
)"
```
````

- [ ] **Step 3: 検証する**

- `cargo test --workspace` と `cargo test -p ghost-meta --features thumbnail,serde` が `.github/workflows/ci-build.yml` のステップと一致すること
- `Opus 4.6` の文字列がファイルから消えていること: `grep -r "Opus 4.6" .claude/skills/` がヒットゼロ

- [ ] **Step 4: コミット**

```powershell
git add .claude/skills/commit/SKILL.md
git commit -m "fix: /commit のチェックリストを CI と整合させモデル名の化石を除去 (#99)

cargo test を --workspace に統一し ghost-meta の features テストを追加
（ローカルで漏れて CI で初めて落ちる穴を塞ぐ）。Co-Authored-By の
Opus 4.6 ハードコードをハーネス既定参照に変更。
スキル定義のみの変更のためテストは書かない。"
```

---

### Task 10: `/pr` スキル修正

**Files:**
- Modify: `.claude/skills/pr/SKILL.md`

**Interfaces:**
- Consumes: なし
- Produces: gh-HTTPS 対応の PR 手順

- [ ] **Step 1: push 手順を gh-HTTPS に差し替える**

`.claude/skills/pr/SKILL.md` のステップ 3 を以下のとおり変更する。

変更前:

````markdown
### ステップ 3: リモートへの push

ブランチがリモートに push 済みか確認し、必要なら push する:

```bash
git push -u origin HEAD
```
````

変更後:

````markdown
### ステップ 3: リモートへの push（gh-HTTPS）

> この環境は SSH push が `~/.ssh/config` の ACL で失敗するため、`/post-merge-sync` と同方式の gh-HTTPS で迂回する。SSH remote にも永続 git config にも触れない。

```bash
git -c credential.helper= -c credential.helper='!gh auth git-credential' \
  push https://github.com/finelagusaz/ghost_launcher.git HEAD
```

URL 指定の push は upstream を設定しないため、`gh pr create` には `--head <ブランチ名>` を明示する。
````

- [ ] **Step 2: PR 作成コマンドに --head を追加し Test plan を追随させる**

同ファイルのステップ 4 の本文テンプレートを変更する。

変更前（コマンド行のみ抜粋）:

````markdown
```
gh pr create --base main --title "タイトル" --body "$(cat <<'EOF'
```
````

変更後:

````markdown
```
gh pr create --base main --head <ブランチ名> --title "タイトル" --body "$(cat <<'EOF'
```
````

Test plan の項目リストを変更する。

変更前:

```markdown
- `npm run build`
- `npm test`
- `npm run check:ui-guidelines`
- `npm run test:ui-guidelines-check`
- `cargo test --manifest-path src-tauri/Cargo.toml`（Rust 変更がある場合）
```

変更後:

```markdown
- `npm run build`
- `npm test`
- `npm run check:ui-guidelines`
- `npm run test:ui-guidelines-check`
- `cargo test --workspace`（Rust 変更がある場合）
- `cargo test -p ghost-meta --features thumbnail,serde`（ghost-meta 変更がある場合）
```

- [ ] **Step 3: 検証する**

- `git push -u origin HEAD` がファイルから消えていること: `grep "push -u origin" .claude/skills/pr/SKILL.md` がヒットゼロ
- gh-HTTPS コマンドの credential.helper 指定が `.claude/skills/post-merge-sync/SKILL.md` と同一形式であること

- [ ] **Step 4: コミット**

```powershell
git add .claude/skills/pr/SKILL.md
git commit -m "fix: /pr の push をこの環境で動く gh-HTTPS 迂回に差し替え (#99)

SSH push は ~/.ssh/config の ACL で失敗するため post-merge-sync と
同方式に統一。Test plan の cargo test 表記も CI と整合させた。
スキル定義のみの変更のためテストは書かない。"
```

---

### Task 11: CLAUDE.md のポインタ化とスキル一覧表

**Files:**
- Modify: `CLAUDE.md`（「作業フロー」節と「コミット前チェックリスト」節）

**Interfaces:**
- Consumes: Task 1-10 で作成・修正した全スキル（一覧表が名前参照）
- Produces: ポインタ化された CLAUDE.md

- [ ] **Step 1: 「作業フロー」節を置換する**

変更前（節全体、7 項目のリスト）:

```markdown
## 作業フロー

1. **作業内容を明確にする** — 要件や目的を確認し、不明点があればユーザーに質問する。複数ファイルにまたがる大きな機能追加・リファクタリングでは plan モードで設計を先に提示し、承認後に実装に入る
2. **調査する** — 関連する既存コード・パターン・依存関係を調べ、影響範囲を把握する
   - 関連する関数の使用箇所を検索し、影響範囲を確認する
   - 対称的なコードパス（追加/削除、成功/失敗）がある場合は両方を確認する
   - 変更しないと判断したファイルについても、その根拠を確認する
   - `.github/workflows/ci-build.yml` を読み、変更が CI で正しく検証されるか確認する
3. **テストを実装する** — コード変更（機能追加・バグ修正）では、期待する振る舞いをテストコードとして先に書く（Red: テストが失敗することを確認する）。ドキュメント更新や CI 設定変更などテスト追加が不適切な作業は、理由をコミットメッセージまたは PR 説明に明記する
   - 削除リファクタリングは Red が書けないため、「削除対象の本番使用ゼロ」を grep で前提検証し、期待外のヒットが出たら中止する
   - テストの種類と置き場: フック → `renderHook`（`src/hooks/*.test.ts`）、ライブラリ → 純粋関数（`src/lib/*.test.ts`）、コンポーネント → `render` + jsdom（`src/components/*.test.tsx`）
4. **テストがパスするように実装する** — テストを満たす最小限のコードを書く（Green: テストが通ることを確認する）
5. **検証する** — コミット前チェックリスト（後述）の全項目が通ることを確認する
6. **コミットする** — 検証が完了し、実装完了 = コミット済みの状態にする。`git status` が clean になるまでセッションを終了しない
7. **PR を作成する** — CI が通ることを確認し、GitHub Flow に従い PR を作成する
```

変更後:

```markdown
## 作業フロー

コード変更（機能追加・バグ修正・リファクタリング）は `/implement` スキルのフローに従う。issue 起点の作業は `/start-issue` から始める。実装完了 = コミット済みの状態にし、`git status` が clean になるまでセッションを終了しない。

## 利用できるスキル

| スキル | 実行時期 | 用途 |
|---|---|---|
| `/start-issue` | issue 着手時 | ブランチ作成〜調査・計画のプリステップ |
| `/implement` | 実装開始時 | 調査→テスト先行→実装→検証→コミットの全サイクル |
| `/ipc-check` | IPC 境界変更時 | Rust↔TS 契約・モック契約の監査 |
| `/symmetry-check` | コード変更時 | 対称パス適用漏れ・コピー統合検討 |
| `/cache-check` | キャッシュ・状態変更時 | 2 層キャッシュ・fingerprint 整合検証 |
| `/health-check` | 定期・サイクル完了後 | SPEC/docs と実装の乖離検査（報告のみ） |
| `/retrospective` | サイクル終了後 | 教訓抽出→RETROSPECTIVE.md 上書き |
| `/deps-update` | 依存更新時 | cargo/npm 一括更新と検証 |
| `/commit` | コミット時 | コミット前チェックリスト実行→コミット |
| `/pr` | PR 作成時 | 変更分析→gh-HTTPS push→PR 作成 |
| `/e2e` | E2E 実行時 | 環境固有の E2E 実行手順 |
| `/post-merge-sync` | PR マージ後 | main 同期・ブランチ後始末 |
```

- [ ] **Step 2: 「コミット前チェックリスト」節を置換する**

変更前（節全体）:

```markdown
## コミット前チェックリスト

- `git status` が "nothing to commit, working tree clean" になっている
- `npm run build` が通る
- `npm test` が通る
- `npm run check:ui-guidelines` が通る
- `npm run test:ui-guidelines-check` が通る
- `cargo test --manifest-path src-tauri/Cargo.toml` が通る
- 新規テストファイルを追加した場合:
  - CI ワークフローでそのテストが実行されるか（`ci-build.yml` に test ステップが存在するか）
  - `tsconfig.json` の `exclude` に追加が必要か
  - `vitest.config.ts` の `include` が検出するか
- UI 操作・言語表示・フォーム入力に関わる変更をした場合:
  - E2E テスト（`npm run e2e`）をローカルで手動実行して動作を確認する
  - E2E テストは CI に含まれないため、手動確認が唯一の統合テスト手段
```

変更後:

```markdown
## コミット前チェックリスト

`/commit` スキルが単一権威。コミットは常に `/commit` のチェックリスト全パス後に行う。
```

- [ ] **Step 3: 検証する**

- 一覧表の 12 スキルすべてが `.claude/skills/<name>/SKILL.md` として実在すること（Glob で確認）
- 削除した内容がスキル側に漏れなく存在すること:
  - 作業フロー 7 ステップの内容 → `/implement`（明確化・調査・Red/Green・テスト置き場・削除リファクタリング）
  - 新規テストファイル確認・E2E 手動確認 → `/commit` の「追加の確認事項」
- `npm run tauri dev` 等「コマンド」節は変更していないこと（`git diff CLAUDE.md` で意図した 2 節のみの変更であることを確認）

- [ ] **Step 4: コミット**

```powershell
git add CLAUDE.md
git commit -m "docs: CLAUDE.md の作業フローとチェックリストをスキルへポインタ化 (#99)

作業フロー 7 ステップは /implement へ、コミット前チェックリストは
/commit へ移植済みのため、CLAUDE.md はポインタとスキル一覧表に置換
（短さが正義・1 in 1 out）。ドキュメントのみの変更のためテストは書かない。"
```

---

### Task 12: 最終検証と PR 作成

**Files:**
- なし（検証と PR のみ）

**Interfaces:**
- Consumes: Task 1-11 の全コミット
- Produces: issue #99 を閉じる PR

- [ ] **Step 1: 全体整合の最終確認**

```powershell
# 化石が残っていないこと
grep -r "Opus 4.6" .claude/skills/ CLAUDE.md
# 期待: ヒットゼロ

# 全スキルの frontmatter name がディレクトリ名と一致すること
Get-ChildItem .claude/skills -Directory | ForEach-Object { $n = (Select-String -Path "$($_.FullName)/SKILL.md" -Pattern '^name: (.+)$').Matches.Groups[1].Value; if ($n -ne $_.Name) { "MISMATCH: $($_.Name) vs $n" } }
# 期待: 出力なし
```

- [ ] **Step 2: コミット前チェックリスト実行**

ドキュメントのみの変更だが、規約に従い全チェックを実行して main のデプロイ可能性を確認する:

```powershell
npm run build
npm test
npm run check:ui-guidelines
npm run test:ui-guidelines-check
cargo test --workspace
cargo test -p ghost-meta --features thumbnail,serde
```

期待: すべて成功（ドキュメント変更はコードに影響しないため、失敗したら変更外の原因を疑い中断・報告する）。

- [ ] **Step 3: git status の確認**

```powershell
git status
```

期待: "nothing to commit, working tree clean"

- [ ] **Step 4: push と PR 作成（修正後の /pr 手順で）**

```powershell
git -c credential.helper= -c credential.helper='!gh auth git-credential' push https://github.com/finelagusaz/ghost_launcher.git HEAD
gh pr create --base main --head refactor/99-skills-redesign --title "refactor: スキル体系を再設計しサイクル系・検証系スキルを導入 (#99)" --body @'
## Summary
- サイクル系スキル新設: /implement（CLAUDE.md 作業フローの移植先）/start-issue /retrospective /deps-update
- 検証系スキル新設: /ipc-check /symmetry-check /cache-check /health-check（RETROSPECTIVE の教訓を検査手順化）
- /commit のチェックリストを CI と整合（--workspace 化・features テスト追加）、Opus 4.6 化石を除去
- /pr の push をこの環境で動く gh-HTTPS 迂回に差し替え
- CLAUDE.md の作業フロー・チェックリストをポインタ化し、スキル一覧表を追加

設計: docs/superpowers/specs/2026-07-04-skills-redesign-design.md

Closes #99

## Test plan
- [x] npm run build
- [x] npm test
- [x] npm run check:ui-guidelines
- [x] npm run test:ui-guidelines-check
- [x] cargo test --workspace
- [x] cargo test -p ghost-meta --features thumbnail,serde
- スキル定義・ドキュメントのみの変更のためテスト追加はなし（理由は各コミットに明記）

🤖 Generated with [Claude Code](https://claude.com/claude-code)
'@
```

- [ ] **Step 5: 結果の報告**

PR の URL をユーザーに伝える。
