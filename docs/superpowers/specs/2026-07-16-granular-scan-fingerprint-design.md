# 設計書: 全走査スキャンの粒度化（issue #134）

- 日付: 2026-07-16
- issue: #134 「perf: 全走査スキャンの粒度化（1体増減で10万体を再走査しない）」
- 前提: PR #133（性能計測ハーネス `scan_bench`/`search_bench`/`bench_support`）は main にマージ済み
- マルチパースペクティブレビュー済み（cache整合・IPC契約・SQLite・エンコーディング・敵対的correctness の5レンズ）

## 1. 問題

10万体規模で `full_scan`（全走査 = walk + parse）が **3.4693 秒/回**。`layer1_hit`（無変更時の高速パス）は
13.357 µs（`docs/perf/baseline-100k.md`）。NTFS の親ディレクトリ mtime は「配下の何かが変わった」ことしか
示さない粒度のため、ゴースト1体の追加・削除のたびに Layer 1（親 mtime 一致判定）がミスし、10万体全件の
walk+parse が走る（数秒の UI フリーズ）。全計測中で最大の絶対レイテンシ。

## 2. 中核の洞察: walk コストは fidelity のツマミである

現行 `scan_ghosts_with_fingerprint_internal`（`scan.rs`）は Layer 1 ミス時に全子を walk（read_dir + stat）
し、`descript.txt` を持つ子を**全て** `read_ghost()` で parse する。案1（fingerprint 粒度細分化）は「変わった
子だけ parse」に置換するが、**「どの子が変わったか」を知るための walk（O(N) stat）は消せない**。

決定的な事実: **walk コスト ＝ 保存する変更検知シグナルの計算コスト ＝ トークンの中身**。この三者は同一の
ダイヤルである。

| 検知レベル | 子1体あたり stat | 検知できる変更 | form-1（単体パース相当・O(1)） |
|---|---|---|---|
| 現行トークン（dir_mtime＋descript_state＋descript_mtime） | 約2〜3 | add/del/rename/**同名置換**/descript出現 | **不可**（O(N) walk 残存） |
| dir_mtime のみ | 1 | add/del/rename/**同名置換** | 不可 |
| 名前集合のみ（read_dir の名前だけ） | **0** | add/del/rename のみ | **到達可** |

**帰結**: 案1（現行トークン保持）は parse しか削れず O(N) walk が構造的に残るため、issue 受け入れ基準の
第一形「単体パース相当」には**設計上届かない**。到達できるのは名前集合レベル（fidelity 最低）のみ。
fidelity と速度は 10万体規模で二律背反であり、**どの点を選ぶかは計測（Phase 1）と fidelity 判断で決める**。

### 2.1 fingerprint と walk の緊張（隠さず明示する）

集約 fingerprint（F-04「ディレクトリ構成・**更新時刻**のハッシュ」）を今日ちょうどの値で保つには、
full-fidelity の stat walk が要る。walk を削れば fingerprint の算出源（＝トークン中身）が変わり、F-04 を
狭める。したがって **fidelity レベルの選択と fingerprint 定義は一つの決定**である。本設計はこの決定を
Phase 1 の後段に置き、それまで先取り確定しない。

### 2.2 実際に争点となる fidelity はただ一つ

SPEC §7.4/§9.1 は既に「既存ゴースト内の descript.txt 編集は Layer 1 で検出せず『再読込』の強制フルスキャンで
対応」と routing 済み。しかも descript の出現・編集は `ghost/`（親）の mtime を bump せず**この Layer1 ミス経路を
そもそも通らない**。ゆえに安価な端（名前集合レベル）で実際に失う fidelity は——**同名置換（同じ dir 名で
削除→再作成）の検知**、この一点のみ。これが名前集合レベルと dir_mtime レベルを分かつ唯一の discriminator。

## 3. スコープと非スコープ

- スコープ: Layer 1 ミス時の Layer 2 を「全 parse」から「差分検知 + 変更子だけ parse」へ置換し、
  1体増減の再走査コストを削減する。計測ハーネスの拡張。
- 非スコープ（今回やらない）: filesystem watcher / USN journal（issue の2案外・大掛かり）。
  Phase 3（非ブロッキング UI）は測定条件付き（§6）。

## 4. correctness 土台（fidelity に依らず確定採用）

レビューが実コード根拠で突いた、fidelity レベルに依らず正しい修正。Phase 2 のどの検知レベルを選んでも共通。

### 4.1 格納先＝案A（per-row テーブル）

新テーブル `ghost_scan_entries`。案C（`ghost_fingerprints` に blob 列）は 1体増減でも約10MB を全書換し
（WAL churn・overflow ページ）、削減した parse コストを書き込み側に転嫁して O(変更数) 目標に自己矛盾する。
案A は変更行だけ UPSERT＝真の O(変更数)。

```sql
CREATE TABLE IF NOT EXISTS ghost_scan_entries (
  request_key TEXT NOT NULL,
  scan_key    TEXT NOT NULL,
  token       TEXT NOT NULL,
  PRIMARY KEY (request_key, scan_key)
) WITHOUT ROWID;
```

- `WITHOUT ROWID` により `(request_key, scan_key, token)` が単一 B-tree のカバリング構成になり、既存
  `ghosts` のカバリング index パターン（`lib.rs`）と一貫。前回状態の読み取りは
  `SELECT scan_key, token FROM ghost_scan_entries WHERE request_key = ?1`（カバリング）。
- 新 migration（version 14 以降）として追加。既存 migration の SQL は一切編集しない（SHA-384 チェックサム
  不変性）。複数文は `\n` 明示（`src-tauri/CLAUDE.md`）。`NOT NULL` 列に DEFAULT は付けない（INSERT 時に常に
  値を渡す。付けるならリテラルのみ）。
- 揮発キャッシュ（`ghosts` と運命共有）。寿命管理（`cleanupOldGhostCaches`）と同一 `request_key` で
  一括削除する対象に含める（SPEC §8.1 の削除経路に追加）。

### 4.2 差分マップのキー＝生の物理キー

`scan_key` は生の物理識別子（`normalized_parent` ＋ セパレータ ＋ **生** `directory_name`）とする。
`ghost_identity_key`（＝ NFKC(source)+\x1f+NFKC(dir_name)）を差分キーに使うと、全角/半角・半角カナ・互換
文字・合成/分解の NFKC 畳み込みで**物理的に別のディレクトリが同一キーに衝突**し、HashMap 上で後勝ち上書き
され、**「ラウドな UNIQUE エラー」が「サイレントなゴースト消失＋ path 振動（run ごとに勝者が入れ替わり
誤ったゴーストを起動）」に退行**する。生キーなら物理ディレクトリごとに別エントリを保ち、UPSERT 段で
`ghost_identity_key` に畳んだとき既存の UNIQUE index が衝突を loud に弾く現挙動を維持する。

- `scan_key` の生キーは走査差分専用。`ghosts` への UPSERT/DELETE では従来どおり `ghost_identity_key` を使う。
- DELETE 対象（前回 scan_key にあり今回 walk に無い子）の `ghosts` 行を消すには `ghost_identity_key` が要る。
  `scan_key` から source と dir_name を復元して算出するか、`ghost_scan_entries` に補助情報を持たせる
  （実装計画で確定。設計上は「生キーで差分し、identity_key で ghosts を操作する」二層を保つことが要件）。
- セパレータは制御文字（`\x1f`/`\x1e` 等）を用い、Windows ファイル名規則（制御文字不可）に暗黙依存する旨を
  コメント明記。パースは防御的に（`splitn` で過剰分割防止）。

### 4.3 集約 fingerprint は生キートークン集合から決定的に算出

fingerprint は畳み込み identity マップからではなく、**生キーのトークン集合**（＋親トークン＋version ヘッダ）
から `compute_fingerprint_hash` 相当で算出する。畳み込みマップから算出すると (1) 親トークン・version が欠落し
情報不足、(2) NFKC 衝突と HashMap 反復順序で**非決定的**になり、Layer 2 等値判定（`mod.rs`）と
`getCachedFingerprint` 往復契約（`ScanStoreResult.fingerprint`）が壊れる。マップと fingerprint は同一 walk から
導かれる2つの派生物であり、同一トランザクションで原子的に共に書く。

### 4.4 delta 適用の正しさ規則

- **変更子（新規＋トークン変化）は parse を試みる。Ghost が得られたら UPSERT、得られなければ（descript
  missing でも parse 失敗＝内容破損でも）その `ghost_identity_key` の `ghosts` 行を DELETE**。現行 `store_ghosts`
  は集合差で「スキャン結果に無いキー」を DELETE するため破損子が消える挙動を持つ。delta もこれに収束させる。
- **削除子（前回 scan_key にあり今回 walk に無い）は DELETE**。
- **不変子（トークン一致）は一切触らない**（parse も DB 書込もしない）。
- **`total` は delta 適用後の `SELECT COUNT(*) FROM ghosts WHERE request_key = ?1` を返す**。`upserts.len()` を
  流用しない（`dbMonitor.ts` の `ALERT_GHOST_COUNT`＝10万閾値監視が壊れる）。`cache_hit=true` なら従来どおり
  `total=0`。この不変条件をテストで固定。
- **`store_ghosts_delta` は `last_launched`/`launch_count` 集計列に触れない**（現行 `store_ghosts` の UPDATE 列
  規律を踏襲）。`scan_and_store` は delta 経路でも commit 後に `backfill_launch_aggregates` を必ず呼ぶ
  （`/symmetry-check` 対象）。
- **子変更0でも `fingerprint`＋`parent_mtimes`（＋不変の scan_entries）を必ず書く**。「親 mtime だけ変化・子
  集合同一」は fingerprint が親トークンを含むため cache_hit=false で delta 経路に入り、parse0/書込0 だが
  fingerprint と parent_mtimes の更新が要る（書き忘れると以後 Layer 1 が毎回ミス＝性能退行）。
- **初回スキャン（前回 scan_entries 不在）はフォールバックでフル walk+parse し、scan_entries を必ず seed する**。
  seed を怠ると delta 経路に永遠に到達しない。フォールバックが既存 `store_ghosts` を通る場合、
  `ghost_fingerprints` の `INSERT OR REPLACE` が scan_entries と別テーブルである点で案C の blob 破壊問題は
  回避される（案A採用の副次的利点）。

### 4.5 無料の walk 削減（is_dir のみ・mtime には及ばない）

`scan.rs` の `p.is_dir()`（full-path stat）を `read_dir` の `DirEntry::file_type().is_dir()`（キャッシュ済み
find-data 参照・syscall ゼロ）に置換する。ディレクトリ属性ビットは陳腐化しないため正しさ不変。これは
fidelity に依らない純粋な削減。

**ただし mtime には及ばない**: Windows の find-data はキャッシュ mtime を無料で持つが、それは本コードベースが
`fs::metadata` で意図的に避けている陳腐化シグナル。「そのキャッシュ mtime が**スキャン間**の検知に足るか」は
不確実であり、**仮定せず Phase 1 の明示的テスト項目とする**（§5）。足りるなら dir_mtime レベルがほぼ無料化し
うる。

## 5. Phase 1 — 意思決定の計器（受け入れ基準の一部・ゲート）

単なる計測でなく、Phase 2 の検知レベルを決める計器。`bench_support.rs` に本番経路ラッパーを露出し、
`scan_bench.rs` に形状を追加する（すべて `#[cfg(feature = "bench")]` ゲート下）。

1. **walk を各 fidelity レベルで測る**:
   - full-fidelity walk（現行トークン・約2〜3 stat）＝ 既存 `full_scan` から parse を除いた `walk_only`
     （`scan_ghosts_with_fingerprint_internal` を ghosts 収集なしで呼ぶ `fingerprint_only(ssp)`）
   - dir_mtime のみ（1 stat）
   - 名前集合のみ（0 per-child stat・read_dir 名前のみ）
   これで **parse コスト = full_scan − walk_only**、および各レベルの walk コストが判明。スペクトラム上の
   どの点が「体感フリーズしない」に入るかを数値で確定する。
2. **`rescan_one_change` 形状**: 「1体増減→ Layer 1 ミス→再走査」の end-to-end。`iter_batched` で**毎イテレーション
   Layer1 ミス＋差分ちょうど1を強制**する（素朴実装だと変異後に Layer1 hit=13µs や差分ゼロ全 walk を誤計測する）。
   現行コードの baseline と、Phase 2 の granular 版を直接比較する。
3. **無料削減の効果測定**: `is_dir`→`file_type` 化前後の walk 差。
4. **キャッシュ mtime 信頼性テスト**: `entry.metadata()` のキャッシュ mtime が、スキャン間（ツリー変異後の
   別プロセス/別 read_dir）で `fs::metadata` と一致し検知に足るかを検証するテスト。dir_mtime レベルの
   実現可否を左右する。

**Phase 1 の出力＝「スペクトラム上のどの点を選ぶか」の材料**（form-1 の可否ではなく、fidelity×速度の選択）。

## 6. Phase 2 — 差分検知 + 変更子だけ parse（トークン機構は Phase 1 で確定）

correctness 土台（§4）は先に固定。**トークン中身（＝walk コスト＝fidelity レベル）だけ Phase 1 の計測と
同名置換 fidelity 判断で確定**する。データフロー（Layer 1 ミス時、レベル非依存の骨格）:

1. 全親を walk → `{scan_key → token}` マップ構築（token 中身はレベル依存、parse なし）
2. 前回の `{scan_key → token}` を `ghost_scan_entries` から読む
3. マップ差分 → 新規/変更（parse 対象）・削除（DELETE 対象）・不変（触らない）
4. 変更分だけ `read_ghost()` parse → Ghost 群
5. 1 トランザクションで: `ghosts` の UPSERT/DELETE（§4.4）＋ `ghost_scan_entries` の UPSERT/DELETE ＋
   `ghost_fingerprints`（fingerprint＋parent_mtimes）更新。commit 後 backfill。

新設: `store_ghosts_delta(conn, request_key, upserts: &[Ghost], deletes: &[identity_key],
scan_entry_upserts, scan_entry_deletes, fingerprint, parent_mtimes)`（対象行だけ操作・全行読み取り不要）。
既存 `store_ghosts` は初回フォールバック用に維持。

**IPC 契約は不変**: `scan_and_store` の引数・戻り値型は変えない。前回 scan_entries は DB 由来でフロントに
露出しない。`Ghost`/`ScanStoreResult` に scan_key/token を混入させない（IPC を渡らない内部表現を保つ）。

## 7. Phase 3 — 非ブロッキング化（測定条件付き・YAGNI ゲート）

Phase 1+2 の実測で、選んだ fidelity レベルの walk 残余が体感フリーズを起こす場合にのみ着手。streaming/
進捗 UI。fidelity を保ちつつ walk が大きい場合は事実上必須化しうる。着手時に IPC 面（event/channel の
ペイロード型を ts-rs 生成にするか）を別途決める。**本設計では前方非互換を生む変更をしない**（Phase 2 の
同期 `Result<ScanStoreResult>` 契約に加算的にイベントを併設できる）。

## 8. 受け入れ基準（正直に再定義）

issue の第一形「単体パース相当」は案1（walk 保持）では原理不可。到達可能な形で再定義する:

- **Phase 1**: `scan_bench` に walk の各 fidelity レベル分解＋`rescan_one_change` 形状が追加され、
  3.47秒の walk/parse 内訳と各レベルの walk コストが数値で確定する。
- **Phase 2**: 選んだ fidelity レベルで、1体増減の再走査コストが `full_scan`（3.47s）から
  **walk_only(そのレベル) + 単体 parse 相当**へ落ちる（名前集合レベルを選べば「単体パース相当」に到達、
  現行トークンレベルを選べば「full-fidelity walk + 単体 parse」）。granular bench 数値で before/after を実証。
- **Phase 3（条件付き）**: 着手した場合、走査中に UI がブロックしない。

## 9. レビューで捕捉した主要リスク（実装計画への申し送り）

| # | リスク | 対策（本設計での扱い） |
|---|---|---|
| C1 | 案C blob が `INSERT OR REPLACE` で消え delta 経路に永遠に到達しない | 案A採用で回避（§4.1） |
| C2 | fingerprint を畳み込みマップから算出すると非決定的 | 生キー集合から算出（§4.3） |
| H1 | mtime は内容変化の完全なプロキシでない（mtime保存編集・サムネイル変更を取りこぼす） | SPEC §7.4 の「再読込」contract に整合。Phase1 で取りこぼしを計測項目化。§2.2 |
| H2 | 変更→parse失敗子の DELETE 漏れ | delta 規則で missing/破損とも DELETE（§4.4） |
| H3 | identity_key 衝突でサイレント消失＋path振動 | 生キー差分＋UNIQUE loud failure 維持（§4.2） |
| IPC | `total` が変更数に化け10万監視が壊れる | `SELECT COUNT(*)` を返す（§4.4） |
| M3 | 起動集計列の消失・backfill 欠落 | 集計列不可侵＋delta 経路でも backfill（§4.4） |

## 10. 検証方針

- Rust: `cargo test`（store_ghosts_delta の差分適用・DELETE 分岐・total=COUNT・0変更 fingerprint 書込・
  NFKC 衝突の loud failure 維持・scan_key 生キー性）。`cargo test --features bench bench_support`。
- ベンチ: `cargo bench --features bench --bench scan_bench`（各 fidelity レベル・rescan_one_change）。
- 回帰: `cargo test`（feature 無効・本番非影響）・`npm test`・`npm run build`・`cargo check`。
- `/cache-check`・`/ipc-check`・`/symmetry-check` の観点で最終監査。
- SPEC.md §7.4 の Layer2 記述を granular 化に合わせて同期（F-04 の fidelity レベルを明記）。
```
