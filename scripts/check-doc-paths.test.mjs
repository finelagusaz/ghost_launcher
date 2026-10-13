import assert from "node:assert/strict";
import test from "node:test";

import { buildIndex, checkDocs, classify, extractInlineCode, toFileRef } from "./check-doc-paths.mjs";

const index = buildIndex([
  "src-tauri/src/cache_schema.rs",
  "src/lib/ghostDatabase.ts",
  ".github/workflows/ci-build.yml",
  "src/locales/en.json",
]);

test("toFileRef: 行番号の接尾辞を落とす", () => {
  assert.equal(toFileRef("src/lib/ghostDatabase.ts:178", index.extensions), "src/lib/ghostDatabase.ts");
  assert.equal(toFileRef("ghostDatabase.ts:3,22-23", index.extensions), "ghostDatabase.ts");
});

test("toFileRef: コマンド・プレースホルダ・glob・ディレクトリは対象外", () => {
  for (const token of [
    "npx vitest run src/lib/ghostDatabase.test.ts",
    "src/locales/{lang}.json",
    "src/lib/*.test.ts",
    "src/lib/",
    "https://example.com/a.md",
  ]) {
    assert.equal(toFileRef(token, index.extensions), null, token);
  }
});

test("toFileRef: 追跡ファイルに無い拡張子（i18n キー・実行時生成物）は対象外", () => {
  assert.equal(toFileRef("settings.language.ru", index.extensions), null);
  assert.equal(toFileRef("ghosts.db", index.extensions), null);
});

test("classify: 完全一致と短縮参照は ok", () => {
  assert.equal(classify("src/lib/ghostDatabase.ts", index).status, "ok");
  assert.equal(classify("cache_schema.rs", index).status, "ok");
  assert.equal(classify("lib/ghostDatabase.ts", index).status, "ok");
  assert.equal(classify("ci-build.yml", index).status, "ok");
});

test("classify: basename は実在するがパスが食い違うものは mismatch", () => {
  const result = classify("crates/ghost-meta/src/cache_schema.rs", index);
  assert.equal(result.status, "mismatch");
  assert.deepEqual(result.candidates, ["src-tauri/src/cache_schema.rs"]);
});

test("classify: パス区切りをまたぐ末尾一致を短縮参照と取り違えない", () => {
  // "src-tauri/src/cache_schema.rs" は文字列としては "i/src/cache_schema.rs" で終わる
  assert.equal(classify("i/src/cache_schema.rs", index).status, "mismatch");
});

test("classify: basename すら無いものは missing", () => {
  assert.equal(classify("src/lib/noSuchFile.ts", index).status, "missing");
});

test("extractInlineCode: フェンスコードブロックの中は抽出しない", () => {
  const markdown = ["`a.ts`", "```bash", "`b.ts`", "```", "````md", "```", "`c.ts`", "````", "`d.ts`"].join("\n");
  assert.deepEqual(
    extractInlineCode(markdown).map((t) => t.token),
    ["a.ts", "d.ts"],
  );
});

test("checkDocs: 検査件数と行番号つきの所見を返す", () => {
  const docs = [{ path: "X.md", content: "`cache_schema.rs` と\n`noSuch.rs` と `settings.label`" }];
  const { findings, checked } = checkDocs(docs, index);
  assert.equal(checked, 2);
  assert.deepEqual(findings, [{ doc: "X.md", line: 2, ref: "noSuch.rs", status: "missing" }]);
});
