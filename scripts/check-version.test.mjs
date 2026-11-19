import assert from "node:assert/strict";
import test from "node:test";

import { cargoPackageVersion, checkVersions, readVersions } from "./check-version.mjs";

test("cargoPackageVersion: [package] の version を読み、依存の version は拾わない", () => {
  const toml = [
    "[package]",
    'name = "ghost-launcher"',
    'version = "0.9.1"',
    "",
    "[dependencies]",
    'serde = { version = "1", features = ["derive"] }',
  ].join("\n");
  assert.equal(cargoPackageVersion(toml), "0.9.1");
});

test("cargoPackageVersion: [package] に version が無ければ null", () => {
  assert.equal(cargoPackageVersion('[package]\nname = "x"\n\n[dependencies]\nversion = "1"\n'), null);
});

const versions = (v) => [
  { file: "package.json", version: v },
  { file: "src-tauri/tauri.conf.json", version: v },
];

test("checkVersions: すべて同じ版なら成功", () => {
  assert.deepEqual(checkVersions(versions("0.9.1")), []);
});

test("checkVersions: 版が食い違えば失敗し、食い違うファイルを挙げる", () => {
  const failures = checkVersions([
    { file: "package.json", version: "0.9.1" },
    { file: "src-tauri/Cargo.toml", version: "0.1.0" },
  ]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /src-tauri\/Cargo\.toml.*0\.1\.0/);
});

test("checkVersions: 版を読めないファイルは失敗", () => {
  const failures = checkVersions([{ file: "package.json", version: null }]);
  assert.equal(failures.length, 1);
});

test("checkVersions: タグを渡すと、v を除いた値がファイルの版と一致するかも見る", () => {
  assert.deepEqual(checkVersions(versions("0.9.2"), "v0.9.2"), []);
  // 食い違うファイルごとに 1 行ずつ報告する
  const failures = checkVersions(versions("0.9.1"), "v0.9.2");
  assert.equal(failures.length, 2);
  for (const failure of failures) assert.match(failure, /v0\.9\.2/);
});

test("readVersions: リポジトリの対象ファイルの版を読める", () => {
  const read = readVersions(process.cwd());
  assert.ok(read.length >= 4);
  for (const { file, version } of read) {
    assert.match(version ?? "", /^\d+\.\d+\.\d+/, file);
  }
});
