# walk スペクトラム計測（10万体規模・#134 Phase 1）

- 計測日: 2026-07-16
- 目的: Phase 2 の fidelity レベル（full/dir_mtime/name-set）を選ぶための walk/parse 内訳と、
  「1体変更→再走査」の現行ベースライン。修正（Phase 2）は本数値を根拠に別サイクル。
- 実行環境: Windows 11 Home 10.0.26200 / ワークスペースは SSD。`bench` プロファイル
  （`cargo bench --features bench`、release 最適化継承）。warm cache（ツリー生成直後・同一プロセス反復）。
- **重要な環境注記**: 本実行の `full_scan`（n=100k）は **6.43s** で、`docs/perf/baseline-100k.md`（#133）の
  **3.47s** の約 **1.85 倍**。計測セッション中のビルド／背景タスクによるコンテンションが主因と見られる
  （同一 build 番号だが baseline は Pro 表記・本実行は Home 表記で環境差の可能性もある）。
  **判断根拠は絶対値でなく、同一実行内の相対比率**とする（全 shape が同条件で走っているため比率は有効）。
- 手順: `cargo bench --features bench --manifest-path src-tauri/Cargo.toml --bench scan_bench`

## walk スペクトラムと parse 内訳（中央値）

| 形状 | n=1k | n=10k | n=100k |
|---|---|---|---|
| full_scan（walk+parse・本番） | 57.78 ms | 629.69 ms | 6.4300 s |
| walk_full_fidelity_3stat（本番 walk・parse抜き・token+hash込み） | 37.40 ms | 382.79 ms | 3.3314 s |
| walk_full_2stat_filetype（stat のみ・token/hash なし） | 7.31 ms | 69.35 ms | 897.00 ms |
| walk_dir_mtime_1stat（stat のみ） | 3.75 ms | 36.87 ms | 476.04 ms |
| walk_nameset_0stat（read_dir + file_type のみ） | 749.21 µs | 6.37 ms | 83.16 ms |
| layer1_hit | 33.40 µs | 28.27 µs | 28.32 µs |
| store_rescan_nodiff | 1.17 ms | 10.35 ms | 157.98 ms |
| rescan_one_change（現行 1体変更→再走査） | 69.77 ms | 665.84 ms | 6.5097 s |

（n=100k は sample_size=10 の indicative 値。criterion の中央値。）

### 導出（n=100k・比率）

- **parse コスト** = full_scan − walk_full_fidelity_3stat = 6.43 − 3.33 = **3.10 s（full_scan の約 48%）**。
- **full-fidelity walk（token+hash 込み）** = **3.33 s（約 52%）**。
- **→ parse と walk は拮抗。どちらも支配的でない。**
- **walk の中身の内訳**（stat モデルは token/hash を含まない点に注意。下記 caveat）:
  - 素の 2-stat（file_type）= 0.897 s。1-stat = 0.476 s。0-stat = 0.083 s。**stat 1 回 ≈ 0.4 s / 100k**。
  - 本番 full-fidelity walk（3.33 s）と 2-stat モデル（0.897 s）の差 **2.43 s** は、is_dir stat（約 0.4 s）＋
    **10万トークンの文字列生成・sort・SHA-256 ハッシュ＋構造体/文字列アロケーション**。
  - つまり **walk コストの過半は stat ではなく「集約 fingerprint の生成」**。これは Phase 2 の設計を左右する
    最重要の発見（後述）。

> **caveat**: `walk_full_2stat_filetype`/`walk_dir_mtime_1stat`/`walk_nameset_0stat` は stat パターンの
> コストモデルであり、**トークン文字列生成・集約 fingerprint ハッシュを含まない**（`fingerprint_only` =
> `walk_full_fidelity_3stat` のみが本番同等に含む）。ゆえに安価レベルの数値は「その stat 数＋相応に安価な
> 集約シグナル」を採る設計での walk 下限であり、実 Phase 2 は何らかの fingerprint コストを別途計上する。

## キャッシュ mtime 信頼性（Task 5 所見）

- 結果: **FAIL**（Windows 11 / NTFS）。ツリー変更後の**新しい read_dir 列挙**でも、`entry.metadata()`
  （find-data 由来・syscall ゼロ）の mtime が `fs::metadata` と不一致（実測差 ~63ms、find-data キャッシュが陳腐化）。
- 含意: **dir_mtime レベルは find-data mtime を無料利用できず、`fs::metadata` で 1 実 stat/子（≈0.4s/100k）が
  必須**。0 syscall 化は不可。コードベースが `fs::metadata` を全面採用している判断（`scan.rs` の NTFS 陳腐化
  回避）が実測で裏付けられた。テストは `#[ignore]` の回帰ガードとして残置（`cargo test --features bench --
  -- --ignored` で再検証可）。

## Phase 2 への含意（fidelity レベル選択）

達成可能な「1体変更→再走査」コスト（walk ＋ 単体 parse ≈ walk 支配。現行ベースライン **6.51 s**）:

| レベル | 検知できる変更 | 再走査コスト目安(100k) | fingerprint(F-04) | Phase 3 要否 |
|---|---|---|---|---|
| full-fidelity（現行トークン保持） | add/del/rename/**同名置換**/descript出現 | **~3.3 s** | 今日ちょうど維持 | **要**（多秒フリーズ残存） |
| dir_mtime（1 stat・安価な集約） | add/del/rename/**同名置換** | **~0.5 s** | descript_mtime を落とし狭める | 恐らく不要（sub秒） |
| name-set（0 stat） | add/del/rename のみ | **~0.08 s** | 名前集合派生に狭める | 不要（単体パース相当） |

### 決定的な結論

1. **full-fidelity granular（parse だけ飛ばす）は不十分**: walk（token+hash 込み 3.33s）が残り、受け入れ基準の
   「単体パース相当」に届かない。この道を選ぶなら Phase 3（非ブロッキング）が事実上必須。
2. **walk コストの過半は集約 fingerprint の再計算**（token 生成＋SHA-256）。ゆえに Phase 2 の勝ち筋は
   「parse を飛ばす」だけでなく **1体変更時に集約 fingerprint を全再計算せず増分更新する**こと。
   これは設計書 §4.3（fingerprint は生キートークン集合から算出）を **増分ハッシュ or per-child 保持署名**へ
   踏み込ませる含意を持つ。
3. **fidelity ツマミの実費**: 同名置換検知（full/dir_mtime）を捨てて name-set に落とすと ~0.5s→~0.08s。
   ただし SPEC §7.4/§9.1 が descript 編集を「再読込」に routing 済みで、descript 出現/編集は Layer1 ミス経路を
   通らないため、name-set で実際に失うのは**同名置換（同 dir 名で削除→再作成）の自動検知の一点**。
4. **無料削減（is_dir→file_type）**: 単独では約 0.4s/100k（stat 1 回分）。token/hash 削減と分離できていない
   ため上限見積り。Phase 2 で walk を作り直す際に本番適用する。

### 推奨（次サイクルの Phase 2 決定材料）

- **第一候補: dir_mtime レベル ＋ 増分 fingerprint**。同名置換検知を保ちつつ ~0.5s（sub秒・Phase 3 不要見込み）。
  F-04 は descript_mtime を落として微縮小（SPEC 同期が要る）。集約 fingerprint を全再計算せず per-child 署名の
  増分で更新する設計が肝。
- name-set レベルは「単体パース相当」を厳密に満たすが、同名置換検知の喪失と F-04 のさらなる縮小を伴う。
  同名置換が運用上どれだけ起きるかを SPEC 判断に上げてから選ぶ。
- いずれにせよ **集約 fingerprint の増分化**が walk 支配を崩す本丸。Phase 2 計画はこれを中心に据える。
