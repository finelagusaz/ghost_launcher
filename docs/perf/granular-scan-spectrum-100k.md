# walk スペクトラム計測（10万体規模・#134 Phase 1）

- 計測日: 2026-07-16
- 目的: Phase 2 の設計（fidelity レベル・walk 最適化）を選ぶための walk/parse 内訳と、
  「1体変更→再走査」の現行ベースライン。修正（Phase 2）は本数値を根拠に別サイクル。
- 実行環境: Windows 11 Home 10.0.26200 / ワークスペースは SSD。`bench` プロファイル
  （`cargo bench --features bench`、release 最適化継承）。warm cache（ツリー生成直後・同一プロセス反復）。
- **環境注記**: 本実行の `full_scan`（n=100k）は **6.18s** で、`docs/perf/baseline-100k.md`（#133）の
  **3.47s** の約 1.8 倍。計測セッション中のビルド／背景タスクによるコンテンションが主因と見られる。
  **判断根拠は絶対値でなく、同一実行内の相対比率**とする（全 shape が同条件のため比率は有効）。
- 手順: `cargo bench --features bench --manifest-path src-tauri/Cargo.toml --bench scan_bench`

## 計測結果（中央値）

| 形状 | n=1k | n=10k | n=100k |
|---|---|---|---|
| full_scan（walk+parse・本番） | 50.57 ms | 622.19 ms | 6.1760 s |
| walk_full_fidelity_3stat（本番 walk・**逐次 is_dir 込み**・parse抜き） | 30.23 ms | 356.99 ms | 3.1899 s |
| **walk_full_fidelity_filetype（同一 fingerprint・逐次 is_dir を file_type 化）** | 7.35 ms | 72.95 ms | **922.50 ms** |
| walk_full_2stat_filetype（stat のみ・token/hash なし） | 6.83 ms | 68.38 ms | 857.94 ms |
| walk_dir_mtime_1stat（stat のみ） | 3.61 ms | 36.66 ms | 458.76 ms |
| walk_nameset_0stat（read_dir + file_type のみ） | 635.50 µs | 6.14 ms | 75.88 ms |
| layer1_hit | 28.21 µs | 28.52 µs | 28.16 µs |
| store_rescan_nodiff | 1.10 ms | 9.68 ms | 142.76 ms |
| rescan_one_change（現行 1体変更→再走査） | 60.85 ms | 631.61 ms | 6.3397 s |

（n=100k は sample_size=10 の indicative 値。criterion の中央値。）

## 内訳（n=100k・比率）

`walk_full_fidelity_3stat` と `walk_full_fidelity_filetype` は**同一 fingerprint を返す**（同値をテストで固定）。
唯一の差は、本番 `walk_parent` の **逐次** is_dir 判定（`scan.rs` の `.filter(|p| p.is_dir())`・
100k 回の逐次 `metadata` syscall）を、キャッシュ済み find-data の `file_type()`（syscall ゼロ）に
置換した点のみ。したがって両者の差 = **逐次 is_dir pass 単独のコスト**。

- **parse コスト** = full_scan − walk_full_fidelity_3stat = 6.176 − 3.190 = **2.99 s（full_scan の約 48%）**。
- **逐次 is_dir pass** = walk_full_fidelity_3stat − walk_full_fidelity_filetype = 3.190 − 0.9225 =
  **2.27 s（full-fidelity walk の 71%）**。← **walk コストの支配項はこれ**。
- **token 生成 + 集約 fingerprint ハッシュ** = walk_full_fidelity_filetype − walk_full_2stat_filetype =
  0.9225 − 0.858 = **≈ 0.065 s（約 2%・無視できる）**。
- 2 並列 stat の内訳: descript stat = 0.858 − 0.459 = 0.40 s、dir stat = 0.459 − 0.076 = 0.38 s、
  read_dir + file_type = 0.076 s。

> **設計判断への含意（重要）**: walk コストの過半（71%）は**逐次 is_dir stat**であり、集約 fingerprint の
> 生成（token+SHA-256）は約 2% に過ぎない。したがって Phase 2 の勝ち筋は「fingerprint の増分化」でも
> 「fidelity を落とす」でもなく、**逐次 is_dir を file_type 化（＋既に並列の 2 stat）する fidelity 無傷の
> 一手**である。これは F-04（descript_mtime 込み）を一切狭めない。

## キャッシュ mtime 信頼性（Task 5 所見）

- 結果: **FAIL**（Windows 11 / NTFS）。新しい read_dir 列挙でも `entry.metadata()`（find-data 由来）の
  mtime が `fs::metadata` と不一致（実測差 ~63ms・find-data キャッシュが陳腐化）。
- 含意: **mtime を要する stat（dir_mtime / descript）は `fs::metadata` が必須**で 0 syscall 化できない。
  ただし `file_type()`（ディレクトリ属性ビット・陳腐化しない）は無料で使える——これが上記の is_dir 削減の
  根拠。コードベースの `fs::metadata` 全面採用（`scan.rs` の NTFS 陳腐化回避）が実測で裏付けられた。
  テストは `#[ignore]` の回帰ガードとして残置。

## Phase 2 への含意（設計判断）

達成可能な「1体変更→再走査」コスト（walk ＋ 変更子だけ parse。現行ベースライン **6.34 s**）:

| 案 | 検知できる変更 | 再走査コスト目安(100k・warm) | fingerprint(F-04) | 妥協 |
|---|---|---|---|---|
| **full fidelity + file_type（推奨）** | add/del/rename/**同名置換**/descript出現 | **~1.05 s** | **今日ちょうど維持** | **なし** |
| dir_mtime + file_type | add/del/rename/**同名置換** | ~0.6 s | descript_mtime を落とし微縮小 | descript 出現の即時検知 |
| name-set | add/del/rename のみ | ~0.22 s | 名前集合派生に縮小 | 同名置換検知 |

（再走査コスト = walk（file_type）＋ **前回トークンマップの O(N) 読み** ≈ store_rescan_nodiff 相当
142.76 ms/100k ＋ delta write ＋ 変更子の parse。full fidelity 案は 0.92s walk + ~0.14s 読み ≈ **~1.05s**。
いずれも **warm cache** の見積り——後述の cold 注意を参照。）

### 決定的な結論（当初推論の訂正）

1. **当初の「walk コスト過半は fingerprint ハッシュ」は誤り**。実測で walk 支配項は**逐次 is_dir stat
   （2.27s・71%）**、token+hash は約 65ms（2%）。判別は `walk_full_fidelity_3stat`（逐次 is_dir）vs
   `walk_full_fidelity_filetype`（file_type・同一 fingerprint）の差で確定。
2. **Phase 2 は「delta 機構 ＋ file_type 化」の両方が必須**（どちらか一方では足りない）。二つの支配項を
   別々に潰す:
   - **parse-skip（delta 機構）** が節約は大きい（**2.99s**）。そしてこれは設計書 §4 の実装本体——
     `ghost_scan_entries`（案A）・`store_ghosts_delta`・生キー差分・5レンズが挙げた correctness 規則の
     すべて。**Phase 2 の作業量の大半はここ**。
   - **逐次 is_dir → file_type**（節約 **2.27s**・fidelity 無傷・F-04 不変）が walk 側のもう一つの大塊を潰す。
   - **片方だけでは不十分**: file_type 単独（delta なし）は walk 0.92s + parse 2.99s ≈ **3.9s** で依然多秒
     フリーズ。delta 単独（逐次 is_dir 残置）は walk 3.19s + 読み ≈ **3.3s** で同様。両方揃って初めて ~1.05s。
3. **incremental fingerprint は不要**（token+hash が 65ms のため、1体変更で全再計算しても安い）。
   設計書 §4.3（fingerprint は生キートークン集合から算出）はそのまま維持でよい。
4. **Phase 3（非ブロッキング）は「不要」でなく「cold-start 挙動の再計測まで保留（deferred）」**。上記
   ~1.05s は **warm cache** の値。Layer 1 ミスは「ユーザーが外部でゴーストフォルダを追加・削除した直後」に
   発火し、その初回スキャンは**セッション開始時＝cold cache**であることが多い。cold の 2-stat walk（10万件の
   実 stat をディスクから）は warm 0.92s の数倍あり得て、多秒フリーズに戻りうる（本 issue の敵対的レビュー
   前提3/5 が指摘済み）。**Phase 3 の要否は warm ベンチでなく cold-cache／実アプリ観測の Layer1 ミス walk で
   判定する**。設計書 §7 の測定条件付きゲートに合致。
5. **副次利得**: full_scan 自体も逐次 is_dir を含むため（6.18s のうち walk 3.19s）、file_type 化で
   初回スキャン・再読込も 6.18s→~3.9s に短縮される（parse 2.99s は残る）。

### Phase 2 計画への申し送り

- 本丸は **`walk_parent` の逐次 is_dir を `entry.file_type()` へ置換**（`scan.rs:137-141`）。symlink は
  `file_type()` が follow しないため、symlink→dir のゴーストを拾うには `file_type().is_dir()` 偽かつ
  symlink のときだけ `fs::metadata` にフォールバックする分岐が要る（正しさ保持）。
- その上で設計書 §4 の correctness 土台（格納先案A `ghost_scan_entries`・生キー差分・delta 正しさ規則・
  変更子だけ parse）を実装し、granular rescan 版の `rescan_one_change` を bench で before(6.34s)/after(~1.05s
  warm) 比較する。fidelity は full を維持するため、同名置換の SPEC 判断は不要になった。
- **Phase 3 の判定材料として cold-cache の Layer1 ミス walk を別途計測する**（warm ベンチは ~1.05s を
  再確認するだけで cold の体感を測れない）。実アプリでの外部フォルダ変更→初回スキャンの体感を観測するのが確実。

## Phase 2 実測（delta 実装後・受け入れ根拠）

- 計測日: 2026-07-16（同一環境・warm cache・`cargo bench --features bench --bench scan_bench -- "rescan|full_scan"`）
- 本実行の `full_scan`（n=100k）は 4.51s で、Phase 1 計測（6.18s）より軽い（実行時コンテンションの差）。判断は絶対値でなく同一実行内の比率で行う。

| 形状 | n=10k | n=100k |
|---|---|---|
| full_scan（walk+parse・per-change の床） | — | **4.51 s** |
| rescan_one_change（**before**・全 walk+parse+store） | 434 ms | **5.59 s** |
| **rescan_one_change_delta（after・granular・本番 delta 経路）** | **125 ms** | **1.40 s** |
| store_rescan_nodiff（参考・差分ゼロ再 store の読み） | 72.6 ms | 0.81 s |

- **結論**: 1 体増減の再走査は **n=100k で 5.59s → 1.40s（約 4.0 倍・75% 減）**、n=10k で 434ms → 125ms（約 3.5 倍）。
  delta（1.40s）は full_scan（4.51s）**より速く**、parse-skip が発生していることを比率が裏づける（parse-skip 自体は
  ユニットテスト `apply_scan_delta_が不変子を再parseしない` が決定論的に固定）。目標 ~1.05s(warm) に対し 1.40s は
  本実行の walk 込みの内訳（file_type walk + 前回 scan_entries 読み + 1 体 parse + delta write）で、比率の勝ちは明確。
- fidelity は full を維持（descript_mtime 込み・同名置換も検知）。副次的に full_scan 自体も逐次 is_dir の file_type 化で
  6.18s → 4.51s に短縮。
