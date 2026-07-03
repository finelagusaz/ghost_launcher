# src/ — フロントエンド作業規約

## テストパターン

**テストモック**: `vitest.config.ts` の `resolve.alias` で `@tauri-apps/*` を `src/test/mocks/` 以下のモジュールに自動差し替え済みのため、テストで `invoke` 等を追加モックなしで使える。

**React コンポーネントテスト**: `setup.ts` で `afterEach(cleanup)` をグローバル設定済みのため、各テストファイルに cleanup を書く必要はない。`act()` で React が要素を差し替えることがあるため、状態変更後は `screen.getByTestId()` 等で要素を再取得する（`act()` 前に得た参照は stale になる）。

**ブラウザ API のモック**: `ResizeObserver` など jsdom に存在しないブラウザ API は `vi.stubGlobal("ResizeObserver", vi.fn(function(cb) { callbacks.push(cb); return { observe: vi.fn(), disconnect: vi.fn() }; }))` でモックし、`afterEach` で `vi.unstubAllGlobals()` を呼ぶ。収集したコールバックを `act()` 内で手動トリガーして状態変化をテストする。**注意**: `vi.fn()` の引数にアロー関数を渡すと `new` で呼べないため、`new ResizeObserver()` を使うコンポーネントのモックは通常関数（`function`）を使う。

**vitest モックのリセット**: `vi.mockClear()` は呼び出し履歴（calls/results）をクリアするが `mockResolvedValue` などの実装は残る。テスト間でモック実装が汚染される場合は `vi.mockReset()` を使う。モジュールレベル変数（フラグ・シングルトン等）をリセットしたい場合は `beforeEach` で `vi.resetModules()` を呼び、dynamic import（`await import('./module')`）でモジュールを再取得する。

**IPC 境界のモック契約**: Rust コマンドの戻り値をモックするとき、Rust 側の不変条件を再現する。例: `scan_and_store` は `cache_hit=true` なら `total: 0` を返す。現実に発生しない組み合わせでモックすると、テストがバグを検知できなくなる。

**外部 UI ライブラリの DOM 出力**: 外部 UI ライブラリの DOM 出力を仮定してアサーションを書かない。先に小さなデバッグテスト（`console.log(element.outerHTML)`）で実際の出力を確認してから assertion を書く。

**テストファイルは型検査されない**: tsconfig は `*.test.ts` を exclude し vitest も型検査しないため、テスト内の型エラーは build/CI で検出されない。コンパイル時の整合検査（`GHOST_VIEW_COLUMNS` の網羅チェック等）は必ず本番ソース側に置く。

## アーキテクチャメモ

**非同期 singleton の初期化**: 複数のセットアップステップを持つ singleton は、初期化 Promise をキャッシュして並行呼び出しを共有する。エラー時のみ Promise をリセットして再試行可能にする（例: `getDb()` の `dbInitPromise` パターン）。

**循環依存の回避（src/lib/）**: モジュール A が B をインポートし、B も A のエクスポートを必要とする場合、B は A の値（例: `Database` インスタンス）を関数パラメータで受け取り、A の直接インポートを避ける。例: `dbMonitor.ts` の `reportDbSize(db, trigger)` は `getDb()` を内部で呼ばず、呼び出し元から `db` を受け取る。

**モジュールスコープ可変状態と React**: モジュールスコープの可変状態（例: `ghostDatabase.ts` の `randomSortSeed`）は React の effect 依存・リセット判定に映らない。クエリ挙動を変える状態変更は epoch として `useState` 化し、`useSearch` の resetKey / deps に配線する（`sortEpoch` パターン）。怠ると旧状態のバッファと新状態のページがマージ縫合される。
