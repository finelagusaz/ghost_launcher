# 性能ベースライン（10万体規模）

- 計測日: 2026-07-16
- 目的: 修正の優先順位を実測で決めるためのベースライン。修正は本数値を根拠に別サイクル。

## 実行環境

- OS: Microsoft Windows 11 Pro 64 ビット（10.0.26200）
- CPU: AMD Ryzen 7 9700X 8-Core Processor（8 コア / 16 論理プロセッサ）
- メモリ: 約 32 GB
- ディスク: SSD（`Get-PhysicalDisk` で確認した 2 台とも `MediaType=SSD`。ワークスペースは SSD 上）
- ビルドプロファイル: `bench` プロファイル（`cargo bench --features bench`。release 最適化を継承）
- SQL 層（search_bench）: 同一プロセス内で同一 DB 接続に対し criterion の warm-up（3 秒）後に繰り返しクエリを発行するため、OS ページキャッシュ・SQLite ページキャッシュともに温まった定常状態（warm-cache）での計測。
- FS 走査層（scan_bench）: ツリー生成直後に同一プロセス内で繰り返し走査するため、NTFS メタデータ・ファイル内容ともに OS キャッシュが温まった状態（warm）での計測。ディスクからの実読み込みを伴うコールドキャッシュのシナリオより高速に出ている可能性がある点に留意。

## 実行手順

```bash
cargo bench --manifest-path src-tauri/Cargo.toml --features bench --bench search_bench
cargo bench --manifest-path src-tauri/Cargo.toml --features bench --bench scan_bench
```

## SQL 層（search_bench）

### EXPLAIN QUERY PLAN（n=1000）

```
--- empty+name ---
  SEARCH g USING INDEX idx_ghosts_request_key_name_lower (request_key=?)
--- like+name ---
  SEARCH g USING INDEX idx_ghosts_request_key_name_lower (request_key=?)
--- empty+recent ---
  SCAN g
  USE TEMP B-TREE FOR ORDER BY
--- empty+frequency ---
  SCAN g
  USE TEMP B-TREE FOR ORDER BY
--- empty+random ---
  SEARCH g USING INDEX idx_ghosts_request_key_identity_fingerprint (request_key=?)
  USE TEMP B-TREE FOR ORDER BY
```

**判定**: `like+name`（先頭ワイルドカード LIKE 付き）も `empty+name`（検索語なし）と全く同じ `SEARCH g USING INDEX idx_ghosts_request_key_name_lower (request_key=?)` になる。これは **LIKE 自体が index 最適化された訳ではない**。複合 index `idx_ghosts_request_key_name_lower` が `request_key` の等値条件でパーティションを絞り込み、かつ index の並び順がそのまま `ORDER BY name_lower` を満たすために index が選ばれているだけであり、`%…%` の LIKE 条件はそのパーティション内を行ごとに評価する残余フィルタとして働く（index にはヒットせず、行ごとの文字列比較になる）。

`empty+recent` / `empty+frequency` は `SCAN g` + `USE TEMP B-TREE FOR ORDER BY`（`request_key` の絞り込みにすら index が使われず、全表相当のスキャン＋全件を一時 B-Tree でソート）。`empty+random` は `request_key` の絞り込みには別 index（`idx_ghosts_request_key_identity_fingerprint`、たまたま request_key を前方に含む別の複合 index）が使われるが、ORDER BY 式（`(g.id * 定数) % 定数` の計算式）は index 化できないため、こちらも `USE TEMP B-TREE FOR ORDER BY` になる。3 ソート形状（recent/frequency/random）はいずれも並び替えに index を使えず全件を一時 B-Tree でソートする点で共通する。

### レイテンシ中央値

| 形状 | n=1k | n=10k | n=100k |
|---|---|---|---|
| empty_sort/name | 30.08 µs | 30.36 µs | 31.91 µs |
| empty_sort/recent | 151.05 µs | 1.4095 ms | 13.993 ms |
| empty_sort/frequency | 148.60 µs | 1.4107 ms | 14.343 ms |
| empty_sort/random | 149.23 µs | 610.08 µs | 7.1803 ms |
| like/none | 247.75 µs | 9.7022 ms | 116.84 ms |
| like/rare | 250.65 µs | 9.7459 ms | 42.186 ms |
| like/common | 186.25 µs | 5.7838 ms | 68.390 ms |
| offset/0 | 32.74 µs | 30.53 µs | 33.20 µs |
| offset/mid | 40.39 µs | 119.27 µs | 1.0168 ms |
| offset/deep | 52.23 µs | 208.52 µs | 4.0289 ms |
| count_plus_select_common | 310.10 µs | 7.5121 ms | 89.719 ms |

（値は criterion の `time: [下限 中央値 上限]` の中央値。）

**like/rare と like/common の逆転について（フィクスチャ由来・一般化不可）**: n=100k で `like/rare`（42.186 ms）が `like/common`（68.390 ms）より速いという、素朴な「マッチ率が高いほど早期終了で速い」という予測に反する結果が出た。原因は `bench_support.rs::synth_ghost` の合成データ生成ロジックにある。`Q_RARE`（`craftman='作者777'`、`i % 1000 == 777`）にマッチする行は必ず `i` が奇数かつ `i % 5 == 2` になるため、名前が例外なく `en[2]="Ghost"` 由来の `"Ghost{i}"` になる。この "Ghost" プレフィックスは ASCII のため `name_lower` 順で非常に早い位置に集まり、`ORDER BY name_lower LIMIT 50` が早期に 50 件へ到達する。一方 `Q_COMMON`（`name` が `"さくら…"`、`i % 10 == 0`）はソートキーである `name_lower` 自身が一致条件のため、集団は "さくら" の Unicode 位置（全角カタカナ・漢字圏内、他の日本語プレフィックスの中間あたり）まで走査が進んでから初めて見つかる。この逆転は **合成データにおける「マッチ列と並び替え列の相関」というフィクスチャ固有の副作用であり、一般化できる知見ではない**（実データでは craftman と name は独立なので、この逆転は起きない見込み）。一般化できる知見は次の一点のみ: **先頭ワイルドカード LIKE は index 最適化されず、`request_key` の絞り込み以降は行ごとの残余フィルタになる**（`like/none` が index 経路の 3662 倍という事実。詳細は後述の所見を参照）。

## FS 走査層（scan_bench）

| 形状 | n=1k | n=10k | n=100k(indicative) |
|---|---|---|---|
| full_scan | 26.663 ms | 299.83 ms | 3.4693 s |
| layer1_hit | 13.195 µs | 13.248 µs | 13.357 µs |
| store_initial | 8.0681 ms | 66.750 ms | 707.14 ms |
| store_rescan_nodiff | 722.32 µs | 4.6802 ms | 84.026 ms |

（n=100k は `sample_size=10` の indicative 値。full_scan はツリー生成直後の warm cache 状態での計測であり、コールドキャッシュのディスク読み込みを含まない点に留意。）

**フル走査 − Layer1 hit = 1 体増減で払う代償**: n=100k で 3.4693 s − 0.013357 ms ≈ **3.469 秒**（約 259,800 倍）。NTFS の親ディレクトリ mtime は「配下の何かが変わった」ことしか示さず、どのゴーストが変わったかまでは分からない粒度のため、100k 体中のどれか 1 体を追加・削除・更新しただけで Layer 1（親 mtime 一致判定）がミスし、100k 体全件の再走査（ディレクトリ列挙 + `descript.txt` パース）が発生する。full_scan は N に対しほぼ線形（1k→10k で 11.25 倍、10k→100k で 11.57 倍。単純な線形なら 10 倍のところ、ディレクトリ規模拡大に伴う readdir コスト増でやや超線形）。

## 所見（修正は別サイクル・推奨のみ）

- **検索（LIKE 先頭ワイルドカード）**: `like/none`（0 件マッチ、パーティション全走査）が index 経路（`empty_sort/name`＝31.91 µs）に対し n=100k で **約 3662 倍**（116.84 ms / 31.91 µs）。先頭ワイルドカード `%…%` は index を使えず、`request_key` で絞られたパーティション内を行ごとに走査する残余フィルタになる（前掲 EXPLAIN QUERY PLAN の判定どおり）。さらに `count_plus_select_common`（本番の 1 検索で毎回併走する `countGhostsByQuery`。`LIMIT` なしのため常にパーティション全走査）は index 経路に対し **約 2812 倍**（89.719 ms / 31.91 µs）で、これはマッチ密度に依らず**検索 1 回ごとに必ず払う不可避コスト**である。→ FTS5 or 前方一致（`LIKE 'prefix%'`、先頭ワイルドカードなしなら index 利用可）の検討。
- **全走査（Layer 1 ミス時のフル再走査）**: `full_scan` が `layer1_hit` に対し n=100k で **約 259,800 倍**（絶対値では 3.469 秒）。全計測項目中で最大の絶対レイテンシであり、NTFS 親 mtime 粒度ゆえゴースト 1 体の増減だけで 100k 体全件の walk+parse が走る。→ fingerprint 粒度細分化（子ディレクトリ単位の変更検知）or 進捗 UI/streaming。
- **ソート（TEMP B-TREE 全ソート）**: `recent`/`frequency`/`random` が `name`（index-ordered top-N）に対し n=100k でそれぞれ **約 438 倍・449 倍・225 倍**（13.993 ms / 14.343 ms / 7.1803 ms ÷ 31.91 µs）。3 ソートとも EXPLAIN QUERY PLAN で `USE TEMP B-TREE FOR ORDER BY` が出ており、全件を一時 B-Tree でソートしてから LIMIT している。→ `(request_key, launch_count)` 等の複合 index。
- **OFFSET（深いページングの線形コスト）**: `offset/deep` が `offset/0` に対し n=100k で **約 121 倍**（4.0289 ms / 33.20 µs）。SQLite の `OFFSET` は指定件数分を読み飛ばすだけで index シークできないため、深いページほど線形に悪化する。→ keyset ページング（前ページ最終行の `name_lower` を境界にした `WHERE name_lower > ?` 方式）。

**推奨優先順位**（絶対レイテンシ × 発生頻度で判断。単純な倍率の大小だけでは優先度を誤る）:

1. **全走査（Layer 1 ミス時のフル再走査）** — 倍率・絶対値とも最大（3.469 秒/回）。ゴースト 1 体の追加・削除という日常的な操作のたびに、100k 体規模ではユーザーが数秒間 UI フリーズを体感しうる。N に対しほぼ線形なので、より小規模な環境でも比例して重くなる。
2. **検索 LIKE 先頭ワイルドカード** — 倍率は全走査に次ぐが、**検索ボックスの 1 キー入力ごと**に発生する最頻の操作であり、`count_plus_select` の不可避コスト（約 90 ms/回）は数千体規模でも累積的な体感遅延になりうる。
3. **ソート（recent/frequency/random の TEMP B-TREE）** — 絶対値は 13〜14 ms とキー入力ほど頻度は高くないが、タブ切り替え・起動直後の既定ソート表示のたびに発生しうる。
4. **OFFSET 深いページング** — 絶対値が最小（4 ms 程度）かつ、本アプリの UI 上で深いページングが頻繁に発生する操作パターンかは未確認。優先度は最も低い。

## 回帰確認（Step 4）

feature 無効の通常ビルド・テストが崩れていないことを確認した（本番 API 不変）。

| コマンド | 結果 |
|---|---|
| `cargo test --manifest-path src-tauri/Cargo.toml` | PASS |
| `cargo check --manifest-path src-tauri/Cargo.toml` | PASS |
| `npm test` | PASS（22 files / 176 tests） |
| `npm run build` | PASS |
