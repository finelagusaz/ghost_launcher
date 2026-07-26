# CLAUDE.md

このファイルは、このリポジトリでコード作業を行う際の Claude Code（claude.ai/code）向けガイドです。

> `SPEC.md` で意図を管理し、コードで実装事実を管理する。`CLAUDE.md` はその橋渡しをする作業規約である。
> **常時ロードされるため、重複はそのままコストになる**。一般則（モデルが既に持つ判断）・ハーネス既定・スキル本文・`package.json` 等から導出できる事実をここへ写さない。書くのはこの repo 固有の落とし穴と、既定を上書きする指示だけ。

## プロジェクト概要

Ghost Launcher は、伺か/SSP ゴーストを検出して起動するための Tauri 2 デスクトップアプリです。SSP のインストールディレクトリと追加のカスタムフォルダを走査し、`descript.txt`（Shift_JIS/UTF-8）からゴーストのメタデータを解析して、検索可能なランチャー UI を提供します。

UI テキストはすべて日本語です。Rust ファイル内のコードコメントも日本語です。

**コミット・PR は即実行**（ハーネス既定の事前確認を上書きする）: コミットや PR 作成の指示は確認なしで実行する。

## コマンド

npm スクリプトは `package.json` が単一権威。Rust は cargo workspace（`cargo test --workspace`）。検証ゲートの正式な一式は `/commit`、E2E の実行手順は `/e2e` が持つ。

```bash
# target フォルダ肥大化時のクリーン（30日以上未使用のビルド成果物を削除。要 cargo install cargo-sweep）
cargo sweep -t 30 .
```

## ディレクトリ構成

フォルダ固有の規約は各フォルダの `CLAUDE.md` が単一権威（`src/`・`src-tauri/`・`e2e/`）。ゴーストメタデータ解析は `crates/ghost-meta/`。

- `src/types/generated/` は ts-rs 自動生成。**手編集禁止**

## 横断パターン

**Tauri コマンド呼び出し**: フロントエンドは `invoke()` で camelCase の引数名を使い、Rust 側では自動的に snake_case に変換されます（例: `sspPath` → `ssp_path`, `additionalFolders` → `additional_folders`）。

**ゴーストのディレクトリ構造**: `{parent}/ghost/{ghost_name}/ghost/master/descript.txt`。`parent` は `{ssp_path}`（SSP ネイティブゴースト用）または、ゴーストサブディレクトリを直接含むユーザー指定の追加フォルダです。

**Claude Code フック**: `.claude/settings.json` のフックは `scripts/hooks/*.sh` を `bash "$CLAUDE_PROJECT_DIR/..."`（絶対パス）で呼ぶ。tool 入力は **stdin の JSON** で渡り `jq -r '.tool_input.file_path'` で取り出す（`$TOOL_INPUT` は存在しない。フックの cwd も保証されないので相対パス厳禁）。

## 判断の勘所

KISS/DRY/SRP/YAGNI・既存パターン踏襲・根本原因まで詰める・不変条件の言語化といった一般則は明文化しない（`/implement` と `/symmetry-check` が使う場面で前提とする）。ここには判断が割れる場面だけを書く。

- **計器を先に較正する**: 新しい診断手段（ログ・サンプラー・監視スクリプト）は、既知の事実を正しく映すことを確認してから証拠として採用する。計器の視界の欠損（ツール環境のプロセス可視性制限等）は「存在するもの」を「存在しない」と誤認させる

## 作業フロー

コード変更（機能追加・バグ修正・リファクタリング）は `/implement` スキルのフローに従う。issue 起点の作業は `/start-issue` から始める。実装完了 = コミット済みの状態にし、`git status` が clean になるまでセッションを終了しない。

スキルは `.claude/skills/` が単一権威（一覧と用途はハーネスが description から供給する）。frontmatter に `disable-model-invocation` を持つものはユーザー起動専用で、モデルからは呼べない——手順が必要なら該当 `SKILL.md` を Read して踏襲する。

複数フェーズ・10 タスク規模・アーキテクチャ変更を伴う大規模作業は、設計書（`docs/superpowers/specs/`）→実装計画（`docs/superpowers/plans/`）→タスク単位実行（各タスクで `/implement` 相当の TDD サイクル）の計画駆動フローへ切り替える（#134 / #146 の実績運用）。

計画駆動フローの最終タスクには**足場撤去 sweep** を定型で置く（規範）。計画・実装中に「後で削除」「後続タスクで置き換え」「プレースホルダ」等と記した仮設コードは、撤去指示がコメントに埋もれると消化が保証されない。サイクル完了前に `grep -rniE 'TODO|FIXME|後続タスク|後で(削除|置き換え|実装)|仮実装|仮置き' src src-tauri crates` で洗い出し、消化を確認する（#133 の `__bench_support_linked` が「後続タスクで置き換える」と書かれたまま #173 まで生存した教訓。`placeholder` 等は UI 属性・i18n キーで恒常ヒットするため意図句に絞る）。機械検証されないため検算手段として `/health-check` 項目 9 を用いる。

実装計画・タスク指示・ドキュメント（CLAUDE.md / SPEC / スキル）には、絶対日付（実時計とドリフトして fixture rot を起こす）・「N 箇所/N 本」の数え上げ（実態とズレる）・検算していない全称/同一性の主張（「すべて」「唯一」「CI と同一」等）を書かない。対象は相対時刻指定と grep コマンドで指示し、事実はコード側の単一権威への参照で示す。強い主張を書くなら既存の全事例に当てて検算し、書けないなら書かない。機械検証されない同期の約束は「規範」であると明記し、検算手段（/health-check 等）を添える。

## ブランチ戦略

GitHub Flow。ブランチ名は `{prefix}/{issue番号}-{英語で内容の説明}`（プレフィックスは `feature/` `fix/` `hotfix/` `release/` `test/` `docs/` `refactor/`。番号のみの `fix/15` は不可）。着手・PR・マージ後の手順は `/start-issue`・`/commit`・`/pr`・`/post-merge-sync` が単一権威。

- **フェーズ分けの作業では、全フェーズ完了後に一括で PR を作成する**（途中フェーズで PR を開くと、後から同一ブランチに追加されたコミットが PR タイトルと乖離し、マージ済み確認が困難になる）
- 複数 PR を並行して進める場合: 一方が CI 失敗すると main ベースの他の PR もマージできなくなる。CI 失敗の原因が共有コード（Rust テスト等）にある場合は優先して修正 PR を立てる

## 参照ドキュメント

- `SPEC.md` — 機能仕様書。振る舞いを変更する場合は実装と同期させる
  - **裁定・仕様変更の反映は追記でなく横断同期**: 関連語で SPEC・設計書・コードコメントを grep し、全出現箇所を同一コミットで揃える（片側だけ直すと文書内・文書間の自己矛盾 drift が残る）
- `docs/ui-guidelines.md` — UI デザインガイドライン
- `docs/locale-customization.md` — ユーザー言語カスタマイズ仕様
- `RETROSPECTIVE.md` — 過去の振り返り（デバッグ教訓・アーキテクチャ上の学び）。更新タイミング・上書き運用・教訓の抽出順序は `/retrospective` が単一権威
