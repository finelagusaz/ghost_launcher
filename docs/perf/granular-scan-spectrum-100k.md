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

| 案 | 検知できる変更 | 再走査コスト目安(100k) | fingerprint(F-04) | 妥協 |
|---|---|---|---|---|
| **full fidelity + file_type（推奨）** | add/del/rename/**同名置換**/descript出現 | **~0.9 s** | **今日ちょうど維持** | **なし** |
| dir_mtime + file_type | add/del/rename/**同名置換** | ~0.5 s | descript_mtime を落とし微縮小 | descript 出現の即時検知 |
| name-set | add/del/rename のみ | ~0.08 s | 名前集合派生に縮小 | 同名置換検知 |

### 決定的な結論（当初推論の訂正）

1. **当初の「walk コスト過半は fingerprint ハッシュ」は誤り**。実測で walk 支配項は**逐次 is_dir stat
   （2.27s・71%）**、token+hash は約 65ms（2%）。判別は `walk_full_fidelity_3stat`（逐次 is_dir）vs
   `walk_full_fidelity_filetype`（file_type・同一 fingerprint）の差で確定。
2. **推奨: full fidelity のまま逐次 is_dir を file_type 化 ＋ 変更子だけ parse**。これで granular rescan は
   **~0.9 s**（file_type walk 0.92s + 単体 parse ≈ 誤差）に落ち、現行 6.34s から約 7 倍改善。
   **同名置換・descript_mtime・exact F-04 をすべて保持**し、fidelity 妥協ゼロ。
3. **incremental fingerprint は不要**（token+hash が 65ms のため、1体変更で全再計算しても安い）。
   設計書 §4.3（fingerprint は生キートークン集合から算出）はそのまま維持でよい。
4. **Phase 3（非ブロッキング）は不要の見込み**。~0.9s は sub 秒で、6.34s の多秒フリーズとは体感が別物。
   最終判断は Phase 2 実装後の再計測で確定する（設計書 §7 の測定条件付きゲートに合致）。
5. **副次利得**: full_scan 自体も逐次 is_dir を含むため（6.18s のうち walk 3.19s）、file_type 化で
   初回スキャン・再読込も 6.18s→~3.9s に短縮される（parse 2.99s は残る）。

### Phase 2 計画への申し送り

- 本丸は **`walk_parent` の逐次 is_dir を `entry.file_type()` へ置換**（`scan.rs:137-141`）。symlink は
  `file_type()` が follow しないため、symlink→dir のゴーストを拾うには `file_type().is_dir()` 偽かつ
  symlink のときだけ `fs::metadata` にフォールバックする分岐が要る（正しさ保持）。
- その上で設計書 §4 の correctness 土台（格納先案A `ghost_scan_entries`・生キー差分・delta 正しさ規則・
  変更子だけ parse）を実装し、granular rescan 版の `rescan_one_change` を bench で before(6.34s)/after(~0.9s)
  比較する。fidelity は full を維持するため、同名置換の SPEC 判断は不要になった。
