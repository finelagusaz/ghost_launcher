# 1 ページ 500 件での読み取り経路の計測（10 万体規模）

- 計測日: 2026-11-19
- 目的: 1 ページの取り出しコストが、件数（50 件と 500 件）でどれだけ変わるかを記録する。`search_bench` の 1 ページの件数を、本番（`src/config/ghost-list.json` の `pageLimit`）と同じ 500 件に揃えたことに伴う計測。
- 背景: これまでの `search_bench` は、1 ページを 50 件で測っていた。そのため `baseline-100k.md` などの記録の数値は 50 件での値で、本番の 1 ページ（500 件）の取り出しコストを小さく見積もっている。

## 実行環境

- OS: Microsoft Windows 11 Pro（10.0.26300）
- CPU: AMD Ryzen 7 9700X 8-Core Processor
- メモリ: 約 31 GB（`Win32_ComputerSystem.TotalPhysicalMemory` の値）
- ビルドプロファイル: `bench`（`cargo bench --features bench`）
- キャッシュ: `baseline-100k.md` と同じく warm-cache（同一接続に warm-up 後、繰り返し発行）

## 実行手順

```bash
cargo bench --manifest-path src-tauri/Cargo.toml --features bench --bench search_bench -- search_n100000 --noplot
```

- 500 件: 同じバイナリで 2 回測った（ノイズの振れ幅を見るため）
- 50 件: 比較のため、ベンチの 1 ページの件数を一時的に 50 に戻して 1 回測った（記録後に 500 へ戻した）

## ノイズの振れ幅

同じバイナリ（500 件）で 2 回測った値の差は、最大で約 12%（`search/none`: 12.167 ms と 10.779 ms）。下の表では、50 件との差がこの幅に収まる項目を「ノイズ内」と書く。

## レイテンシ中央値（n=100k）

| 項目 | 50 件 | 500 件（1 回目） | 500 件（2 回目） | 500 件 / 50 件 |
|------|------:|------:|------:|------:|
| empty_sort/name | 34.958 µs | 144.00 µs | 141.34 µs | 約 4 倍 |
| empty_sort/recent | 37.843 µs | 1.0790 ms | 1.0304 ms | 約 28 倍 |
| empty_sort/frequency | 36.088 µs | 1.2463 ms | 1.1581 ms | 約 33 倍 |
| empty_sort/random | 11.683 ms | 20.491 ms | 18.540 ms | 約 1.7 倍 |
| search/none | 11.034 ms | 12.167 ms | 10.779 ms | ノイズ内 |
| search/rare | 3.9518 ms | 12.332 ms | 11.627 ms | 約 3 倍 |
| search/common | 6.8013 ms | 7.3254 ms | 7.0892 ms | ノイズ内 |
| search_recent/none | 12.692 ms | 13.042 ms | 12.455 ms | ノイズ内 |
| search_recent/common | 8.2773 ms | 9.6971 ms | 8.6643 ms | 約 1.0〜1.2 倍（ノイズと同程度） |
| offset/0 | 35.608 µs | 144.52 µs | 142.63 µs | 約 4 倍 |
| offset/mid | 3.7303 ms | 4.2008 ms | 4.1147 ms | 約 1.1 倍（ノイズと同程度） |
| offset/deep | 7.8777 ms | 8.4902 ms | 8.0866 ms | ノイズ内 |
| count_plus_select_common | 17.833 ms | 18.621 ms | 18.068 ms | ノイズ内 |
| select_only_common | 6.7539 ms | 7.1115 ms | 7.0496 ms | ノイズ内 |

倍率は、500 件の 2 回の値をそれぞれ 50 件の値で割り、丸めた概数。

## 所見

- **件数の影響が大きいのは、並びの先頭から 1 ページ分を取り出して打ち切る形**（`empty_sort/name`・`recent`・`frequency`、`offset/0`、`search/rare`）。取り出す行数がそのままコストになる。50 件の記録は、これらを本番より小さく見積もっていた。
  - `empty_sort/random` も約 1.7 倍になる（11.683 ms から 18.540〜20.491 ms へ、約 7〜9 ms の増加）。全件を並べ替えてから取り出す形なので、50 件でも約 12 ms かかる。増えた分の内訳は、この計測では切り分けていない。
  - `empty_sort/recent`・`frequency` は、50 件ではほぼ `name` と同じ（約 36〜38 µs）だった。
  - 500 件では約 1.0〜1.2 ms で、`name`（約 0.14 ms）の 7〜9 倍になる。件数が増えると、並び順の違いがコストの差として現れる。
  - この差の原因（index の形・行の取り出し方）は、この計測では切り分けていない。
  - `search/rare` は一致する行がまれなので、500 件を集めるまでに走査する行が多くなる。
- **件数の差がノイズ内か、ノイズと同程度なのは、パーティション全体や深い位置まで走査する形**（`search/none`・`search/common`・`count_plus_select_common`・`offset/mid`・`offset/deep` など）。コストの大半は走査で、取り出す行数の差はノイズに埋もれる。
- 本番の 1 ページは 500 件である。読み取り経路の性能を議論するときは、この記録の 500 件の値を使う。
