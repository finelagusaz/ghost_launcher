# src/ — フロントエンド作業規約

## テストパターン

**テストモック**: `vitest.config.ts` の `resolve.alias` で `@tauri-apps/*` を `src/test/mocks/` 以下のモジュールに自動差し替え済みのため、テストで `invoke` 等を追加モックなしで使える。

**React コンポーネントテスト**: `setup.ts` で `afterEach(cleanup)` をグローバル設定済みのため、各テストファイルに cleanup を書く必要はない。`act()` で React が要素を差し替えることがあるため、状態変更後は `screen.getByTestId()` 等で要素を再取得する（`act()` 前に得た参照は stale になる）。

**ブラウザ API のモック**: `ResizeObserver` など jsdom に存在しないブラウザ API は `vi.stubGlobal("ResizeObserver", vi.fn(function(cb) { callbacks.push(cb); return { observe: vi.fn(), disconnect: vi.fn() }; }))` でモックし、`afterEach` で `vi.unstubAllGlobals()` を呼ぶ。収集したコールバックを `act()` 内で手動トリガーして状態変化をテストする。**注意**: `vi.fn()` の引数にアロー関数を渡すと `new` で呼べないため、`new ResizeObserver()` を使うコンポーネントのモックは通常関数（`function`）を使う。

**vitest モックのリセット**: `vi.mockClear()` は呼び出し履歴（calls/results）をクリアするが `mockResolvedValue` などの実装は残る。テスト間でモック実装が汚染される場合は `vi.mockReset()` を使う。モジュールレベル変数（フラグ・シングルトン等）をリセットしたい場合は `beforeEach` で `vi.resetModules()` を呼び、dynamic import（`await import('./module')`）でモジュールを再取得する。

**IPC 境界のモック契約**: Rust コマンドの戻り値をモックするとき、Rust 側の不変条件を再現する。例: `scan_ghosts_with_meta` は `cache_hit=true` なら必ず `ghosts: []` を返す。`cache_hit: true, ghosts: [1件]` のような現実に発生しない組み合わせでモックすると、テストがバグを検知できなくなる。

**外部 UI ライブラリの DOM 出力**: 外部 UI ライブラリの DOM 出力を仮定してアサーションを書かない。先に小さなデバッグテスト（`console.log(element.outerHTML)`）で実際の出力を確認してから assertion を書く。

## アーキテクチャメモ

**非同期 singleton の初期化**: 複数のセットアップステップを持つ singleton は、全ステップ完了後にインスタンスを変数へ代入する。途中で代入すると後続のセットアップが失敗した場合に不完全なインスタンスが固定される（例: `getDb()` で PRAGMA 実行前に `dbInstance = db` と代入しない）。
