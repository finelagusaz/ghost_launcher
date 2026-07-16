# 実装計画: 全走査スキャンの粒度化 Phase 2（delta 機構）

- 日付: 2026-07-16
- issue: #134 「perf: 全走査スキャンの粒度化」
- 起点: 設計書 `docs/superpowers/specs/2026-07-16-granular-scan-fingerprint-design.md` §4／所見 `docs/perf/granular-scan-spectrum-100k.md`
- ブランチ: `feature/134-granular-scan-phase2-delta`（1 PR・2 コミット）
- レビュー: file_type 化・delta 設計とも advisor（上位モデル）で検証済み

## 目標

Layer 2 ミス時の「全 parse」を「差分検知 ＋ 変更子だけ parse」へ置換し、1 体増減の再走査を
6.34s → ~1.05s(warm) へ。fidelity は full 維持（同名置換の SPEC 判断は不要）。

## コミット構成

- **コミット 1（済・`eb713d9`）**: 逐次 is_dir を file_type 化（walk 支配項 2.27s 除去・fingerprint バイト同一・junction フォールバック）。
- **コミット 2（本計画）**: delta 機構（parse-skip 2.99s）＋ bench 整合・granular rescan ＋ SPEC 同期。

## delta データフロー（scan_and_store の Layer 2 ミス経路）

1. **delta walk**（新設・parse なし）: 全親を file_type walk し、present/非present 問わず各子の
   `ScanEntry { scan_key, token, ghost_identity_key, path, source, is_present }` を収集。fingerprint は
   全トークン（version＋親＋不在親＋entry）から `compute_fingerprint_hash`（現行とバイト同一）。
2. **in-memory 一意性ガード**（advisor 指摘の要）: present エントリ上で `HashMap<identity, scan_key>` を張り、
   別 scan_key が同一 identity → loud `Err`。不変子スキップで DB 側 UNIQUE の loud 性が失われる穴を、
   walk 出力（不変子も含む）上の独立ガードで塞ぐ。DB read ゼロ・現行 loud 意味論を再現。
3. cache_hit（fingerprint == cached）なら Layer 2 hit: parent_mtimes 更新して return（現行挙動保存）。
4. **前回 scan_entries を読む** → `HashMap<scan_key, (token, identity_key)>`（O(N)・~142ms 相当・budget 済）。
5. **差分**: scan_key 新規 or token 変化 → 変更子（parse 対象）。前回にあり今回に無い scan_key → 削除子。
   token 一致 → 不変（無触）。
6. **変更子だけ parse**（rayon・present のみ read_ghost）: 成功 → upsert、失敗（missing/破損）→ その identity を DELETE。
7. **`store_ghosts_delta`**（1 tx）:
   - upsert 群を targeted read（`WHERE identity IN (変更子の identity)`）＋消費的 remove で INSERT/UPDATE 分類。
   - deletes（削除子の identity ＋ parse 失敗子の identity）を DELETE（**upsert より先に適用**）。
   - `ghost_scan_entries`: 変更子を INSERT OR REPLACE、削除子を DELETE（不変子は無触）。
   - `ghost_fingerprints`（fingerprint＋parent_mtimes）を INSERT OR REPLACE。
   - `total = SELECT COUNT(*) FROM ghosts WHERE request_key=?`。集計列（last_launched/launch_count）不可侵。
   - commit 後 `backfill_launch_aggregates`。
8. **初回/移行フォールバック**: 前回 scan_entries 空なら全子が「新規」= 全 parse。upsert は targeted read が
   既存 ghosts と突合するため、移行時（ghosts 既存・scan_entries 空）でも UNIQUE 衝突せず UPDATE で吸収。
   → 専用フォールバック関数は不要（delta が自然に O(N) 縮退）。この経路は一意性ガードの穴に**免疫**（全子再処理）。

## スキーマ（migration version 14）

```sql
CREATE TABLE IF NOT EXISTS ghost_scan_entries (
  request_key TEXT NOT NULL,
  scan_key    TEXT NOT NULL,
  token       TEXT NOT NULL,
  ghost_identity_key TEXT NOT NULL,
  PRIMARY KEY (request_key, scan_key)
) WITHOUT ROWID;
```

- `scan_key` = 生の物理キー（`normalized_parent` ＋ `\x1f` ＋ **生** `directory_name`）。NFKC 畳み込み不使用
  （§4.2・サイレント消失防止）。差分専用。
- `ghost_identity_key` = `normalize_for_key(source)` ＋ `\x1f` ＋ `normalize_for_key(directory_name)`
  （store の `build_ghost_identity_key` と同値）。削除子の `ghosts` 操作・一意性ガードに使う。
- version 1〜13 の SQL は不可侵（SHA-384 チェックサム）。複数文は `\n` 明示・NOT NULL に DEFAULT 付けない。
- 揮発キャッシュ（`ghosts` と運命共有）。フロント `cleanupOldGhostCaches` の削除対象に追加。

## 共有関数の抽出

`store.rs` の identity 算出を `pub(crate) fn ghost_identity_key(source, directory_name) -> String` に抽出し、
`build_ghost_identity_key(ghost)` と delta walk の双方から呼ぶ（walk 時 identity と ghost の identity の一致を保証）。

## 固定するテスト（most-likely-bug 順）

1. **fingerprint パリティ**: 新 delta walk の fingerprint が `scan_ghosts_with_fingerprint_internal` と
   同一ツリーでバイト一致（version＋親＋不在親＋entry 全トークン）。2 実装の drift ガード。
2. **一意性ガードの穴**（advisor 指定）: ゴーストを seed → 名前が NFKC で畳み込まれる新ディレクトリを足して
   再スキャン → **loud Err**（silent 上書きでないこと）。「同一スキャン内 2 者衝突」でなく「新規が不変既存に畳み込む」を突く。
3. **identity_key 一致**: parse 済み ghost に対し walk 時 identity == `build_ghost_identity_key(ghost)`（1 assertion）。
4. **delta 適用**: 変更子のみ UPSERT／削除子 DELETE／不変子は updated_at 不変（無触）。
5. **parse 失敗子**: descript 破損 → `ghosts` から DELETE だが scan_entry は UPSERT（dir は存在＝gone でない）。
6. **0 子変更（親 mtime のみ変化）**: parse0/書込0 でも fingerprint＋parent_mtimes を書き、次回 Layer 1 が再 hit。
7. **`total = COUNT(*)`**（`upserts.len()` 流用でない・10万監視保護）。
8. **初回/移行**: scan_entries 空 ＋ ghosts 既存 → UNIQUE 衝突せず UPDATE 吸収＋scan_entries seed。
9. フロント: `cleanupOldGhostCaches` が `ghost_scan_entries` を request_key で削除。
10. migration v14 がインメモリ DB に適用できる（`lib.rs` の既存テスト）。

## bench（コミット 2 に集約）

- file_type 化で `fingerprint_only_internal`（＝bench の `walk_full_fidelity_3stat`）が file_type 化し
  `fingerprint_only_filetype_internal` と同値に collapse。**冗長な filetype 変種・ignored 診断テストを撤去**し
  `walk_full_fidelity_3stat`→`walk_full_fidelity` へ改称。
- `rescan_one_change` の granular 版を追加し before(6.34s)/after(~1.05s warm) を実 `store_ghosts_delta` で end-to-end 比較
  （再実装でなく本番経路を駆動）。

## SPEC 同期

`SPEC.md` §7.4 の Layer 2 記述を delta 化に合わせて更新（fidelity は full 維持・`ghost_scan_entries` の存在）。
`src-tauri/CLAUDE.md` の store 節に delta を追記。ルート CLAUDE.md のモジュール表は新ファイル増設時のみ。

## 検証

`cargo test --workspace`／`npm test`／`npm run build`／`cargo test --features bench --no-run`／
生成型差分ゼロ。`/cache-check`・`/ipc-check`（契約不変の確認）・`/symmetry-check`。
