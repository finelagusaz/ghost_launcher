# スキル体系再設計 — 開発サイクルの手順スキル化

## 背景と目的

現在のプロジェクトスキルは Git 運用の自動化（`/commit` `/pr` `/e2e` `/post-merge-sync`）に寄っており、開発サイクルの節目（着手・実装・検証・振り返り）と品質検証の観点（IPC 契約・対称性・キャッシュ整合・ドキュメント整合）が手順化されていない。一方で RETROSPECTIVE.md のネクストアクション（テストモック契約監査・セマンティクス変更検査・コピー前統合検討）は、まさに検証手順の不在が生んだ教訓である。

参考にした [Snotra の CLAUDE.md](https://github.com/finelagusaz/Snotra/blob/main/CLAUDE.md) は「チェック観点のスキル化」と「サイクル節目のスキル化」を実践している。同型の体系を、このプロジェクトのバグ史・技術制約に合わせて導入する。

## 設計方針

### 配置基準: CLAUDE.md とスキルの線引き

- **CLAUDE.md（常駐メモリ）** — 常時効くべき判断基準を置く: 開発方針（KISS/DRY/SRP/YAGNI）、デバッグ・バグ修正の原則、ブランチ戦略
- **スキル（遅延読み込み）** — 特定局面の手順を置く: 作業フロー、チェックリスト、検証手順。発火時にしか文脈に載らないため、詳細に書いても常時コストはスキル一覧（description）のみ

この基準に従い、CLAUDE.md の「作業フロー」節を `/implement` へ、「コミット前チェックリスト」節を `/commit` へ移植し、CLAUDE.md 側はポインタ化する（1 in 1 out）。

### 発火方式: /implement からの条件発火 + 単体呼び出し

検証系スキルは `/implement` の検証フェーズが変更領域に応じて条件発火する。これにより発火漏れを構造的に防ぐ。同時に各検証スキルは単体のスラッシュ呼び出しも可能とし、`/implement` を通らない小修正の事後検査にも使える。

### スキルとサブエージェントの役割分担

スキルは「いつ・何を検査するかの手順書」（メイン文脈で実行）、サブエージェントは「独立文脈の検査官」（バイアスなしの並列レビュー）。`/ipc-check` は既存の `ipc-boundary-checker` サブエージェントを実働部隊として使い、スキル側は検査観点の指定と結果判定に徹する。

## スキル体系全体像（計 12）

```
サイクル系（作業の流れ）              検証系（品質の網）
─────────────────────              ─────────────────────
/start-issue ── 着手                /ipc-check      ─ IPC 契約
     ↓                             /symmetry-check ─ 対称性・DRY
/implement ─── 調査→Red→Green ──→  /cache-check    ─ 状態整合
     ↓          検証フェーズで条件発火   /health-check   ─ ドキュメント整合（定期）
/commit（既存・修正）
     ↓
/pr（既存・修正）
     ↓
/post-merge-sync（既存・維持）
     ↓
/retrospective ─ サイクル締め

独立系: /e2e（既存・維持）、/deps-update（新設）
```

| スキル | 実行時期 | 用途 | モデル自動発火 |
|---|---|---|---|
| `/start-issue` | issue 着手時 | ブランチ作成〜調査・計画のプリステップ | 可 |
| `/implement` | 実装開始時 | 調査→テスト先行→実装→検証→コミットの全サイクル | 可 |
| `/ipc-check` | IPC 境界変更時 | Rust↔TS 契約・モック契約の監査 | 可 |
| `/symmetry-check` | コード変更時 | 対称パス適用漏れ・コピー統合検討 | 可 |
| `/cache-check` | キャッシュ・状態変更時 | 2 層キャッシュ・fingerprint 整合検証 | 可 |
| `/health-check` | 定期・サイクル完了後 | SPEC/docs と実装の乖離検査（報告のみ） | 不可 |
| `/retrospective` | サイクル終了後 | 教訓抽出→RETROSPECTIVE.md 上書き | 不可 |
| `/deps-update` | 依存更新時 | cargo/npm 一括更新と検証 | 不可 |
| `/commit` | コミット時 | チェックリスト実行→コミット（単一権威化） | 可（既存） |
| `/pr` | PR 作成時 | gh-HTTPS push + PR 作成 | 可（既存） |
| `/e2e` | E2E 実行時 | 環境固有の E2E 実行手順 | 不可（既存） |
| `/post-merge-sync` | マージ後 | main 同期・ブランチ後始末 | 不可（既存） |

## サイクル系スキル詳細

### `/implement` — 実装フルサイクル（CLAUDE.md 作業フローの移植先）

1. **明確化** — 不明点をまとめて質問。複数ファイル横断の大きな変更は plan モードで設計を先に提示
2. **ブランチ確認** — main 上なら命名規則 `{prefix}/{issue番号}-{英語説明}` の作業ブランチを先に切る。issue 起点なら `/start-issue` を案内
3. **調査** — 使用箇所検索・対称コードパス確認・変更しないファイルの根拠確認・`ci-build.yml` での検証可否確認
4. **Red** — 期待する振る舞いをテストとして先に書き、失敗を確認。削除リファクタリングは「削除対象の本番使用ゼロ」の grep 前提検証で代替
5. **Green** — テストを満たす最小実装
6. **検証フェーズ（条件発火表）**:

   | 変更が触れた領域 | 発火するスキル |
   |---|---|
   | `src-tauri/src/commands/`・invoke ラッパー（`src/lib/`）・`src/types/generated/` | `/ipc-check` |
   | 既存関数のコピー改変、追加/削除・成功/失敗の対称ペア | `/symmetry-check` |
   | キャッシュ・fingerprint・request_key・DB スキーマ | `/cache-check` |
   | UI 操作・言語表示・フォーム | E2E 手動実行の要否を判断（`/e2e` を案内） |

7. **締め** — SPEC.md に影響する振る舞い変更は同一コミットで SPEC.md も更新し、`/commit` へ接続

境界: コミットの実処理は `/commit`、PR は `/pr` に委譲する（手順を重複記載しない）。

### `/start-issue` — 着手プリステップ

`gh issue view N` で内容把握 → `git status` clean 確認 → main を最新化（gh-HTTPS 迂回、`/post-merge-sync` と同方式）→ `{prefix}/{N}-{英語説明}` でブランチ作成 → issue の要求を調査し着手方針を短く提示 → `/implement` へ接続。

### `/retrospective` — サイクル締め

教訓を列挙 → 各教訓の**行き先を判定**（ルート CLAUDE.md / フォルダ CLAUDE.md / 該当スキル / どこにも入れない）→ **抽出を先にコミット** → その後に RETROSPECTIVE.md を上書き → ネクストアクションの issue 起票を提案。

CLAUDE.md の既存ルール「抽出前に上書きすると教訓が失われる」を手順として強制する。

### `/deps-update` — 依存更新

`npm outdated` + `cargo update --dry-run` で現状把握 → メジャー更新は個別に影響確認（tauri 系は CLI/api/プラグインの版揃え、`rusqlite`/`libsqlite3-sys` の links 制約は `src-tauri/CLAUDE.md` 参照）→ 更新実行 → コミット前チェックリスト全実行 → UI に波及しうる更新なら `/e2e` を推奨 → `/commit`・`/pr` へ。

## 検証系スキル詳細

### `/ipc-check` — IPC 境界の契約検証

1. **生成型の同期** — IPC struct 変更後に `cargo test` を回し、`src/types/generated/` の差分がコミットに含まれているか（CI「Verify generated types are committed」の先回り）
2. **命名変換の非対称** — 引数は camelCase→snake_case 自動変換されるが、**戻り値のフィールド名は変換されない**（snake_case のまま JS に渡る）。この非対称の取り違えを検査
3. **セマンティクス変更検査** — 戻り値の「空・省略・null」の意味を変えた変更では、受け手の全コードパスを列挙して解釈を確認（`cache_hit=true → ghosts:[]` 全削除バグの再発防止）
4. **テストモック契約監査** — invoke をモックするテストが Rust 側の実契約で発生しうる組み合わせだけを返しているか。現実に発生しない組み合わせのモックは本物のバグを検知できない無意味テスト

変更が大きい場合は `ipc-boundary-checker` サブエージェントに委譲する。

### `/symmetry-check` — 対称性・DRY 検証

1. **対称ペアの適用漏れ** — 追加/削除・成功/失敗・登録/解除・保存/読込のペアを列挙し、片側だけ変更されていないか grep で確認
2. **コピー改変の検出** — 既存関数のコピーで作られたコードを特定し、パラメータ追加での統合可能性を先に検討（`scan_parent_one_pass` 重複の教訓）
3. **DRY 判定基準** — 2 回までは許容、3 回目で抽出検討（CLAUDE.md の基準を適用）
4. **二重実装の整合** — Rust/JS で同じロジックを持つ箇所（request_key 計算・ソート順など）は仕様が両側で一致しているか確認（localeCompare/cmp の順序逆転の教訓）

Snotra では symmetric-check と dry-check の 2 本だが、発火条件がほぼ同じ「コード変更時」のため 1 本に統合する。

### `/cache-check` — キャッシュ・状態整合検証

1. **2 層キャッシュの独立リセット耐性** — localStorage と SQLite の片側だけ消えたケースで整合が崩れないか（「DB 空 → fingerprint 送らない → 必ずフルスキャン」の安全弁の維持）
2. **揮発/永続の分離** — 揮発キャッシュ ghosts.db と永続 user-data.db の運命共有が生じていないか。永続テーブルへの `DELETE FROM` 混入がないか
3. **非正規化集計列の同期経路** — `last_launched`/`launch_count` の即時更新（`record_launch`）と backfill（`scan_and_store`）の両経路が変更後も揃っているか
4. **マイグレーション不変性** — 適用済みマイグレーション SQL の編集がないか（チェックサム不一致 = 起動不能）
5. **状態遷移の到達可能性** — 新しい状態やフラグを足した場合、リセット経路と初期値がすべての遷移で定義されているか

### `/health-check` — ドキュメント整合検査（報告のみ）

各項目とも**報告のみで修正しない**。修正は優先度判断を経て別途指示を受けてから行う。

1. SPEC.md の記述と実装の乖離（コマンド一覧・振る舞い・DB スキーマ）
2. ルート CLAUDE.md のコマンド・パス・ディレクトリ構成図が実在と一致するか
3. フォルダ CLAUDE.md（`src/` `src-tauri/` `e2e/`）の記述鮮度
4. `docs/ui-guidelines.md`・`docs/locale-customization.md` と実装の一致
5. **スキル自身の化石検出** — 各 SKILL.md 内のコマンド・パス・バージョン表記が現在も有効か
6. `ci-build.yml` とコミット前チェックリスト（`/commit`）の整合
7. `src/types/generated/` のコミット漏れ・孤児ファイル
8. RETROSPECTIVE.md のネクストアクションが issue 化 or 消化されているか

出力: 項目ごとに ✅/⚠️ と根拠（file:line）を表形式で報告する。

## 既存スキルの修正

### `/commit`

1. **Co-Authored-By の化石除去** — `Claude Opus 4.6` のハードコードを削除し、「ハーネス既定の Co-Authored-By 表記に従う」へ変更。モデル名をスキルに固定しない
2. **チェックリストの単一権威化と CI 整合**:
   - `cargo test --manifest-path` 2 連発 → `cargo test --workspace` に簡素化（CI と同一コマンド）
   - CI にある `cargo test -p ghost-meta --features thumbnail,serde` をチェックリストに追加（現状ローカルで漏れており CI で初めて落ちる穴）

### `/pr`

1. **push 手順の環境適合** — `git push -u origin HEAD`（SSH・この環境では失敗）を gh-HTTPS 迂回に差し替え:

   ```bash
   git -c credential.helper= -c credential.helper='!gh auth git-credential' \
     push https://github.com/finelagusaz/ghost_launcher.git HEAD
   ```

2. Test plan の項目名を新チェックリスト（`cargo test --workspace` 等）に追随

### `/e2e` `/post-merge-sync`

変更なし（点検の結果、記述は現状と一致）。

## CLAUDE.md の変更（1 in 1 out）

| 節 | 変更 |
|---|---|
| 作業フロー（7 ステップ） | 削除 → 「コード変更は `/implement` に従う」1 行 + スキル一覧表に置換 |
| コミット前チェックリスト | 削除 → 「`/commit` スキルが単一権威」の 1 行に置換 |
| 開発方針・デバッグ原則・ブランチ戦略 | 残す（手順ではなく常時効く判断基準のため） |

差し引きで CLAUDE.md は 20 行前後の純減。

## 採らなかった案

- **検証統合型（/change-check 1 本に条件マトリクス内包）** — スキル数は減るが 1 ファイルが肥大し、該当しない節まで発火時に文脈へ載る。KISS に反するため棄却
- **最小構成（検証を /implement 内のチェックリストに内包）** — 単体呼び出し（「キャッシュ周りだけ検査して」）ができず、`/implement` を通らない小修正で検証が素通りするため棄却
- **symmetric-check / dry-check の分離維持（Snotra 準拠）** — 発火条件が同一のため統合。分離の利点（個別発火）が生きない

## 実装の進め方

- 成果物: 新規 `.claude/skills/*/SKILL.md` × 8、修正 × 2（commit/pr）、CLAUDE.md 編集 × 1
- ドキュメントのみの変更のため Red テストは書けない。CLAUDE.md の規約に従い、その旨をコミットメッセージに明記する
- スキル作成は `superpowers:writing-skills` スキルの手順に従う
- 全スキル作成後に一括で PR（フェーズ分け作業の PR 運用に準拠）
