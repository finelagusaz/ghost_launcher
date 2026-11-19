import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// アプリの版を持つファイル。リリースのたびにすべて同じ版へ上げる（手順は docs/development.md）。
// crates/ghost-meta はアプリの版と独立した内部ライブラリなので対象外。

/// Cargo.toml の [package] 節の version を返す（依存の version は拾わない）。無ければ null。
export function cargoPackageVersion(toml) {
  const section = toml.match(/^\[package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m);
  if (!section) return null;
  const version = section[1].match(/^version\s*=\s*"([^"]+)"/m);
  return version ? version[1] : null;
}

/// 対象ファイルの版を読む。読めないものは version: null で返す（照合で失敗にする）。
export function readVersions(root) {
  const json = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));
  const lock = json("package-lock.json");
  return [
    { file: "package.json", version: json("package.json").version ?? null },
    { file: "package-lock.json", version: lock.version ?? null },
    { file: 'package-lock.json（packages[""]）', version: lock.packages?.[""]?.version ?? null },
    { file: "src-tauri/tauri.conf.json", version: json("src-tauri/tauri.conf.json").version ?? null },
    {
      file: "src-tauri/Cargo.toml",
      version: cargoPackageVersion(readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8")),
    },
  ];
}

/// 版がすべて同じかを見る。tag（例: v0.9.2）を渡すと、v を除いた値と一致するかも見る。失敗の一覧を返す。
export function checkVersions(versions, tag = undefined) {
  const failures = [];
  for (const { file, version } of versions) {
    if (!version) failures.push(`${file}: 版を読めません`);
  }
  if (failures.length > 0) return failures;

  const expected = tag !== undefined ? tag.replace(/^v/, "") : versions[0].version;
  const source = tag !== undefined ? `タグ ${tag}` : versions[0].file;
  for (const { file, version } of versions) {
    if (version !== expected) {
      failures.push(`${file}: ${version}（${source} は ${expected}）`);
    }
  }
  return failures;
}

function runCli() {
  const tagIndex = process.argv.indexOf("--tag");
  const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : undefined;
  if (tagIndex >= 0 && !tag) {
    console.error("--tag の値がありません（例: --tag v0.9.2）");
    process.exit(1);
  }

  const versions = readVersions(process.cwd());
  const failures = checkVersions(versions, tag);
  if (failures.length > 0) {
    console.error("版の照合に失敗しました。リリースのたびに、対象ファイルの版をすべて同じ値へ上げてください。");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`版の照合: ${versions[0].version}${tag ? `（タグ ${tag}）` : ""} で ${versions.length} 件一致`);
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  runCli();
}
