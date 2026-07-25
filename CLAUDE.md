# CLAUDE.md

このファイルは、このリポジトリでコード作業を行う際の Claude Code（claude.ai/code）向けガイドです。

> `SPEC.md` で意図を管理し、コードで実装事実を管理する。`CLAUDE.md` はその橋渡しをする作業規約である。

## プロジェクト概要

Ghost Launcher は、伺か/SSP ゴーストを検出して起動するための Tauri 2 デスクトップアプリです。SSP のインストールディレクトリと追加のカスタムフォルダを走査し、`descript.txt`（Shift_JIS/UTF-8）からゴーストのメタデータを解析して、検索可能なランチャー UI を提供します。

## コミュニケーション方針

- **実行にバイアス**: 明確なタスクは分析・計画より実行を優先する。ユーザーが具体的な修正指示を出した場合は最小限の確認で着手する
- **コミット・PR は即実行**: コミットや PR 作成の指示は確認なしで実行する
- **分析は発見事項のみ**: 分析を求められたら発見事項のみを報告し、求められていない実装計画には踏み込まない
- **不明点は先に質問**: 着手前に不明点がある場合は、作業を始める前にまとめて質問する

## 言語

UI テキストはすべて日本語です。Rust ファイル内のコードコメントも日本語です。

## コマンド

```bash
# 開発（Vite 開発サーバーと Tauri を同時起動）
npm run tauri dev

# フロントエンドのみ（Vite 開発サーバー: ポート 1420）
npm run dev

# フロントエンドをビルド
npm run build

# フロントエンドのユニットテスト（vitest。単一ファイルは npx vitest run <path>）
npm test

# UI ガイドライン静的チェック
npm run check:ui-guidelines

# Rust バックエンドのコンパイル確認
cd src-tauri && cargo check

# Rust テストの実行
cargo test --manifest-path src-tauri/Cargo.toml

# ghost-meta クレートのテスト実行
cargo test --manifest-path crates/ghost-meta/Cargo.toml

# アプリ全体をビルド
npm run tauri build

# E2E テストのセットアップ（初回のみ・tauri-driver 導入 + no-bundle ビルド）
npm run e2e:setup

# E2E テストの実行（事前に npm run tauri build が必要）
npm run e2e

# target フォルダ肥大化時のクリーン（30日以上未使用のビルド成果物を削除。要 cargo install cargo-sweep）
cargo sweep -t 30 .
```

## ディレクトリ構成

```
ghost_launcher/
├── src/                        # フロントエンド（React 19 / TypeScript）→ src/CLAUDE.md
│   ├── lib/                    # Tauri 呼び出し・ビジネスロジック
│   ├── hooks/                  # React カスタムフック
│   ├── components/             # React コンポーネント
│   ├── types/                  # TS 型定義（generated/ は ts-rs 自動生成・手編集禁止）
│   ├── locales/                # UI 翻訳リソース（ja/en/zh-CN/zh-TW/ko/ru）
│   ├── test/                   # vitest セットアップ・Tauri API モック・fixtures
│   └── App.tsx                 # ルートコンポーネント
├── src-tauri/                  # Rust バックエンド → src-tauri/CLAUDE.md
│   └── src/
│       ├── commands/
│       │   ├── ghost/          # ゴーストスキャン・フィンガープリント
│       │   ├── ssp.rs          # ゴースト起動・SSP パス検証コマンド
│       │   ├── launch_history.rs # 起動履歴記録（record_launch）・user-data.db 管理
│       │   └── locale.rs       # ユーザー言語ファイル読込
│       ├── actor/              # ghosts.db/user-data.db への全書込を直列化する単一 writer アクター（mod.rs: Job enum、db_path.rs: パス解決の単一権威）
│       ├── cache_schema.rs     # ghosts.db の使い捨てスキーマ（CACHE_SCHEMA が単一権威・ハッシュ user_version で自動リビルド）
│       ├── bench_support.rs    # 性能計測ハーネス（feature="bench" 限定・本番非コンパイル）
│       └── lib.rs              # Tauri アプリビルダー
├── crates/ghost-meta/          # ゴーストメタデータ解析クレート
│   └── src/                    # descript.txt パーサー・ゴースト走査・サムネイル解決
├── e2e/                        # E2E テスト → e2e/CLAUDE.md
│   ├── helpers/
│   │   ├── harness.ts          # tauri-driver 起動・WebDriver セッション管理
│   │   └── ui.ts               # 共通 UI ヘルパー（waitForAppReady など）
│   ├── ghost-list.e2e.ts       # ゴースト一覧・検索・スクロールの E2E テスト
│   └── i18n.e2e.ts             # 言語切り替え・NFKC 正規化の E2E テスト
├── scripts/                    # UI ガイドライン検査（check-ui-guidelines.mjs）・Claude Code フック（hooks/*.sh）
├── docs/
│   ├── ui-guidelines.md        # UI デザインガイドライン
│   └── locale-customization.md # ユーザー言語カスタマイズ仕様
├── Cargo.toml                  # workspace ルート（src-tauri + crates/ghost-meta）
├── RETROSPECTIVE.md            # 過去の振り返り（サイクル毎に上書き）
└── SPEC.md                     # 機能仕様書
```

## アーキテクチャ

**Tauri 2 アプリ**: Rust バックエンド + React 19 / TypeScript フロントエンド。

### バックエンド（`src-tauri/src/` + `crates/ghost-meta/`）

- `lib.rs` — Tauri アプリビルダー。コマンド・プラグイン登録。setup 内で DB アクター起動配線（`actor::bootstrap`）
- `commands/ghost/` — ゴーストスキャン・DB 書き込み・フィンガープリントコマンド群。`scan.rs`（Rayon 並列スキャン + 型変換）、`store.rs`（rusqlite 差分 UPSERT）、`fingerprint.rs`（2 層差分検知）、`path_utils.rs`（パス正規化）、`types.rs`（型定義）
- `commands/ssp.rs` — `launch_ghost`（`ssp.exe /g {ghost}` 起動）・`validate_ssp_path` コマンド
- `crates/ghost-meta/` — ゴーストメタデータ解析ワークスペースクレート。`descript.txt` パーサー・ゴースト走査・サムネイル解決

### フロントエンド（`src/`）

- `lib/` — Tauri コマンド呼び出しラッパー・キャッシュ寿命管理・起動ロジック・設定ストア
- `hooks/` — 設定・ゴーストスキャン・検索・仮想スクロール・テーマ検出などの React カスタムフック
- `components/` — React UI コンポーネント（一覧は `src/components/` のファイル自体が単一権威。ここに列挙を複製しない）

### 横断パターン

**Tauri コマンド呼び出し**: フロントエンドは `invoke()` で camelCase の引数名を使い、Rust 側では自動的に snake_case に変換されます（例: `sspPath` → `ssp_path`, `additionalFolders` → `additional_folders`）。

**ゴーストのディレクトリ構造**: `{parent}/ghost/{ghost_name}/ghost/master/descript.txt`。`parent` は `{ssp_path}`（SSP ネイティブゴースト用）または、ゴーストサブディレクトリを直接含むユーザー指定の追加フォルダです。

**Claude Code フック**: `.claude/settings.json` のフックは `scripts/hooks/*.sh` を `bash "$CLAUDE_PROJECT_DIR/..."`（絶対パス）で呼ぶ。tool 入力は **stdin の JSON** で渡り `jq -r '.tool_input.file_path'` で取り出す（`$TOOL_INPUT` は存在しない。フックの cwd も保証されないので相対パス厳禁）。

## 開発方針

- **KISS**: シンプルさを最優先する。1つの関数は1つのことだけを行い、短く保つ。到達不能なフォールバックや使われない汎用化は書かない
- **DRY**: 同一ロジックの繰り返しを避ける。ただし無理な抽象化よりも多少の重複を許容する（2回までは許容、3回目で抽出を検討）
- **SRP**: 各モジュール・関数・コンポーネントは単一の責務を持つ。複数の責務が混在したら分割する
- **YAGNI**: 現在の要件に必要なコードだけを書く。「将来必要になるかもしれない」機能・抽象化・設定項目は作らない
- **既存パターン踏襲**: 新規コードは既存のファイル構成・命名規則・スタイルパターンに合わせる。独自の新しいパターンを導入する前に既存パターンの利用を検討する
- **根本原因の修正**: バグ修正後に症状が別のテストやコードに移動した場合、根本原因に未達のサイン。「なぜ直ったか」を確認し、同一パターンのバグが他のコードパスに存在しないか検索してから修正を完了する

## 作業フロー

コード変更（機能追加・バグ修正・リファクタリング）は `/implement` スキルのフローに従う。issue 起点の作業は `/start-issue` から始める。実装完了 = コミット済みの状態にし、`git status` が clean になるまでセッションを終了しない。

複数フェーズ・10 タスク規模・アーキテクチャ変更を伴う大規模作業は、設計書（`docs/superpowers/specs/`）→実装計画（`docs/superpowers/plans/`）→タスク単位実行（各タスクで `/implement` 相当の TDD サイクル）の計画駆動フローへ切り替える（#134 / #146 の実績運用）。

計画駆動フローの最終タスクには**足場撤去 sweep** を定型で置く（規範）。計画・実装中に「後で削除」「後続タスクで置き換え」「プレースホルダ」等と記した仮設コードは、撤去指示がコメントに埋もれると消化が保証されない。サイクル完了前に `grep -rniE 'TODO|FIXME|後続タスク|後で(削除|置き換え|実装)|仮実装|仮置き' src src-tauri crates` で洗い出し、消化を確認する（#133 の `__bench_support_linked` が「後続タスクで置き換える」と書かれたまま #173 まで生存した教訓。`placeholder` 等は UI 属性・i18n キーで恒常ヒットするため意図句に絞る）。機械検証されないため検算手段として `/health-check` 項目 9 を用いる。

実装計画・タスク指示・ドキュメント（CLAUDE.md / SPEC / スキル）には、絶対日付（実時計とドリフトして fixture rot を起こす）・「N 箇所/N 本」の数え上げ（実態とズレる）・検算していない全称/同一性の主張（「すべて」「唯一」「CI と同一」等）を書かない。対象は相対時刻指定と grep コマンドで指示し、事実はコード側の単一権威への参照で示す。強い主張を書くなら既存の全事例に当てて検算し、書けないなら書かない。機械検証されない同期の約束は「規範」であると明記し、検算手段（/health-check 等）を添える。

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
| `/pr` | PR 作成時 | 変更分析→push→PR 作成 |
| `/e2e` | E2E 実行時 | 環境固有の E2E 実行手順 |
| `/post-merge-sync` | PR マージ後 | main 同期・ブランチ後始末 |

## デバッグ・バグ修正の原則

- **不変条件の特定**: 修正に着手する前に、壊れているはずの不変条件を言語化する。「何が常に真でなければならないか」を明確にしてからコードを読む
- **推測の連鎖を避ける**: 最初の修正仮説が失敗したら、同じ方向に推測を重ねず、より深い調査（ログ追加・テスト追加）に切り替える
- **同一パターンの検索**: 修正前にコードベース全体を検索し、同一パターンのバグが他のコードパスに潜んでいないか確認する
- **症状の移動に注意**: 修正後に別のテストが失敗し始めた場合、根本原因に未達のサイン。症状を移動させるだけの修正は完了とみなさない
- **計器を先に較正する**: 新しい診断手段（ログ・サンプラー・監視スクリプト）は、既知の事実を正しく映すことを確認してから証拠として採用する。計器の視界の欠損（ツール環境のプロセス可視性制限等）は「存在するもの」を「存在しない」と誤認させる

## コミット前チェックリスト

`/commit` スキルが単一権威。コミットは常に `/commit` のチェックリスト全パス後に行う。

## ブランチ戦略

GitHub Flow に準拠する。

### 基本ルール

- `main` ブランチは常にデプロイ可能な状態を保つ
- すべての作業は `main` から派生したブランチで行う
- ブランチは PR マージ後に速やかに削除する
- ブランチを作成する前に `git status` が "nothing to commit, working tree clean" であることを確認する

### ブランチ命名規則

形式: `{prefix}/{issue番号}-{英語で内容の説明}`
プレフィックス: `feature/` | `fix/` | `hotfix/` | `release/` | `test/` | `docs/` | `refactor/`
例: `fix/15-validation-cancel-error`, `feature/15-ghost-folder-sorting`。番号のみ（`fix/15`）は不可。

### PR 運用

1. `main` から作業ブランチを作成
2. 作業単位でこまめにコミット（実装完了 = コミット済みかつ CI が通る状態）
3. **フェーズ分けの作業では、全フェーズ完了後に一括で PR を作成する**（途中フェーズで PR を開くと、後から同一ブランチに追加されたコミットが PR タイトルと乖離し、マージ済み確認が困難になる）
4. コミット前チェックリスト（`/commit`）がすべて通ることを確認してから PR を作成
5. PR マージ後にブランチを削除
6. 複数 PR を並行して進める場合: 一方が CI 失敗すると main ベースの他の PR もマージできなくなる。CI 失敗の原因が共有コード（Rust テスト等）にある場合は優先して修正 PR を立てる

### スカッシュマージのマージ済み確認

スカッシュマージでは元コミットが main の祖先に入らないため、`git log main..branch` は「未マージ」と誤検知する。内容が main に取り込まれているかは `git diff main..branch --stat` で判断する。差分がほぼゼロなら実質マージ済み。

**ただし差分ゼロ判定が使えるのはマージ直後のブランチだけ**。main が先行した古いブランチでは、差分の大半が「main が獲得した変更をブランチが持っていない」ことの裏返しとして大量の削除行に見える。数字の大きさを未マージの作業量と読み違えないこと。古いブランチは `gh pr view <branch> --json state,headRefName` が `MERGED` かつ head 一致であることと、実装が main に実在すること（`git grep <語> main -- <path>`）で判定する。

## CLAUDE.md の保守ルール

- **短さが正義**: 読まれないルールは存在しないのと同じ。追記する前に「これは本当にここに要るか」を問う
- **コードの近くに置く**: フォルダ固有の知識はそのフォルダの `CLAUDE.md` に書く。作業者の視線の先にルールがあることが重要
- **更新タイミング**: 実装・レビュー・修正が完了し、パターンとして確定したときに更新する。作業中の仮説や未検証の知見は書かない
- **1 in 1 out を意識する**: 新しいルールを足すとき、不要になったルールの削除を検討する

## 参照ドキュメント

- `SPEC.md` — 機能仕様書。振る舞いを変更する場合は実装と同期させる
  - **裁定・仕様変更の反映は追記でなく横断同期**: 関連語で SPEC・設計書・コードコメントを grep し、全出現箇所を同一コミットで揃える（片側だけ直すと文書内・文書間の自己矛盾 drift が残る）
- `docs/ui-guidelines.md` — UI デザインガイドライン
- `docs/locale-customization.md` — ユーザー言語カスタマイズ仕様
- `RETROSPECTIVE.md` — 過去の振り返り（デバッグ教訓・アーキテクチャ上の学び）
  - **更新タイミング**: サイクル終了後（実装・レビュー・追加修正まで完了したとき）
  - **更新方法**: 上書き（追記しない）。前回サイクルの内容を新サイクルの振り返りで置き換える
  - **持続タスクを置かない**: ネクストアクションは PR チェックリストか issue へ振り分ける（迷ったら issue。「検討」も追跡するなら issue 化、しないなら意図的スキップと明記。詳細は `/retrospective`）
  - **更新手順**: 新しいパターン・教訓を先に `CLAUDE.md` / `src/CLAUDE.md` 等のフォルダ規約 / スキルに抽出してから、`RETROSPECTIVE.md` を上書きする。抽出前に上書きすると教訓が失われる
