import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

// フックを実際の呼び出し形（stdin に tool 入力の JSON）で走らせる。
// payload を文字列で渡した場合はそのまま stdin へ流す（壊れた入力の検査用）。
function runHook(name, payload, env = undefined) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const result = spawnSync("bash", [join(HOOKS_DIR, name)], {
    input,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : undefined,
  });
  assert.equal(result.error, undefined, `bash を起動できない: ${String(result.error)}`);
  return result;
}

// モデルへ届くのは hookSpecificOutput.additionalContext だけ。素の標準出力は届かない。
function contextOf(result, eventName) {
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, eventName);
  return parsed.hookSpecificOutput.additionalContext;
}

const edit = (filePath, extra = {}) => ({ tool_input: { file_path: filePath, ...extra } });

test("warn-generated-edit: Windows パスの生成型編集を additionalContext で警告する", () => {
  const result = runHook(
    "warn-generated-edit.sh",
    edit("C:\\workspace\\ghost_launcher\\src\\types\\generated\\Ghost.ts"),
  );
  assert.equal(result.status, 0);
  assert.match(contextOf(result, "PreToolUse"), /ts-rs/);
});

test("warn-generated-edit: 対象外のパスでは何も出さない", () => {
  const result = runHook("warn-generated-edit.sh", edit("C:/workspace/ghost_launcher/src/types/index.ts"));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("warn-protected-file-edit: ロックファイルと .env を警告する", () => {
  for (const path of ["C:/repo/Cargo.lock", "C:\\repo\\package-lock.json", "C:/repo/.env", "C:/repo/.env.local"]) {
    const result = runHook("warn-protected-file-edit.sh", edit(path));
    assert.equal(result.status, 0, path);
    assert.match(contextOf(result, "PreToolUse"), /保護対象/, path);
  }
});

test("warn-protected-file-edit: 対象外のパスでは何も出さない", () => {
  const result = runHook("warn-protected-file-edit.sh", edit("C:/repo/package.json"));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("warn-cache-schema-edit: Edit でも Write でも DDL を含む CACHE_SCHEMA 編集を警告する", () => {
  const path = "C:/repo/src-tauri/src/cache_schema.rs";
  for (const extra of [{ new_string: "CREATE INDEX idx_x ON ghosts(name)" }, { content: "CREATE TABLE ghosts (id)" }]) {
    const result = runHook("warn-cache-schema-edit.sh", edit(path, extra));
    assert.equal(result.status, 0);
    assert.match(contextOf(result, "PreToolUse"), /CACHE_SCHEMA/);
  }
});

test("warn-cache-schema-edit: DDL を含まない編集・別ファイルでは何も出さない", () => {
  for (const payload of [
    edit("C:/repo/src-tauri/src/cache_schema.rs", { new_string: "// コメントの修正" }),
    edit("C:/repo/src-tauri/src/lib.rs", { new_string: "CREATE TABLE x" }),
  ]) {
    const result = runHook("warn-cache-schema-edit.sh", payload);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  }
});

test("検査系フック: 対象外の拡張子では検査を走らせず何も出さない", () => {
  for (const name of ["check-ts-types.sh", "check-rust-clippy.sh"]) {
    const result = runHook(name, edit("C:/repo/README.md"));
    assert.equal(result.status, 0, name);
    assert.equal(result.stdout, "", name);
  }
});

test("全フック: tool 入力を読めないときは黙って通さず、非 0 終了で stderr に出す", () => {
  for (const name of [
    "warn-generated-edit.sh",
    "warn-protected-file-edit.sh",
    "warn-cache-schema-edit.sh",
    "check-ts-types.sh",
    "check-rust-clippy.sh",
  ]) {
    const result = runHook(name, "{ 壊れた JSON");
    assert.notEqual(result.status, 0, name);
    assert.notEqual(result.status, 2, `${name}: exit 2 はツール呼び出しを止めてしまう`);
    assert.notEqual(result.stderr, "", name);
  }
});

// 検査系フックの試験用の場。PATH の先頭へ偽の cargo を置き、git のプロジェクト（project）と
// そのワークツリー（worktree）、別のリポジトリ（other）を作る。CLAUDE_PROJECT_DIR は project を指す。
// ワークツリーのセッションでも CLAUDE_PROJECT_DIR は元のチェックアウトを指すため、その状況を再現する。
function withProject(cargoBody, fn) {
  const root = mkdtempSync(join(tmpdir(), "hook-project-"));
  const git = (cwd, ...args) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  };
  const repo = (name) => {
    const dir = join(root, name);
    mkdirSync(join(dir, "src"), { recursive: true });
    git(root, "init", "-q", name);
    git(dir, "commit", "-q", "--allow-empty", "-m", "init");
    return dir;
  };
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "cargo"), `#!/bin/bash\n${cargoBody}\n`, { mode: 0o755 });
    const project = repo("project");
    const other = repo("other");
    const worktree = join(root, "worktree");
    git(project, "worktree", "add", "-q", "--detach", worktree);
    mkdirSync(join(worktree, "src"), { recursive: true });
    return fn({
      env: { PATH: `${bin}${delimiter}${process.env.PATH}`, CLAUDE_PROJECT_DIR: project },
      file: {
        project: join(project, "src", "lib.rs"),
        worktree: join(worktree, "src", "lib.rs"),
        other: join(other, "src", "lib.rs"),
      },
      worktree,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 偽の cargo が、実行された場所（作業ツリーの根）を出して失敗する
const REPORT_CWD = 'echo "cwd=$(pwd -W 2>/dev/null || pwd)"; exit 101';

test("check-rust-clippy: clippy の失敗を additionalContext で知らせる", () => {
  withProject('echo "error: unused variable"; exit 101', ({ env, file }) => {
    const result = runHook("check-rust-clippy.sh", edit(file.project), env);
    assert.equal(result.status, 0);
    assert.match(contextOf(result, "PostToolUse"), /unused variable/);
  });
});

test("check-rust-clippy: ワークツリーで編集したら、元のチェックアウトでなくそのワークツリーを検査する", () => {
  withProject(REPORT_CWD, ({ env, file, worktree }) => {
    const result = runHook("check-rust-clippy.sh", edit(file.worktree), env);
    assert.equal(result.status, 0);
    const context = contextOf(result, "PostToolUse").replaceAll("\\", "/").toLowerCase();
    assert.ok(context.includes(`cwd=${worktree.replaceAll("\\", "/").toLowerCase()}`), context);
  });
});

test("check-rust-clippy: プロジェクトの外（別のリポジトリ・リポジトリ外）のファイルは検査しない", () => {
  withProject(REPORT_CWD, ({ env, file }) => {
    for (const path of [file.other, "C:/no/such/repo/lib.rs"]) {
      const result = runHook("check-rust-clippy.sh", edit(path), env);
      assert.equal(result.status, 0, path);
      assert.equal(result.stdout, "", path);
    }
  });
});

test("check-rust-clippy: 時間内に終わらなければ自分で打ち切り、確かめていないことを知らせる", () => {
  // ハーネスに打ち切られると、何も届かないおそれがある。その手前で打ち切って知らせる
  withProject("sleep 30", ({ env, file }) => {
    const started = Date.now();
    const result = runHook("check-rust-clippy.sh", edit(file.project), {
      ...env,
      GHOST_HOOK_CLIPPY_TIMEOUT: "1",
    });
    assert.ok(Date.now() - started < 20_000, "打ち切り時間で止まっていない");
    assert.equal(result.status, 0);
    assert.match(contextOf(result, "PostToolUse"), /打ち切/);
  });
});

test("check-rust-clippy: clippy が通れば何も出さない", () => {
  withProject("exit 0", ({ env, file }) => {
    const result = runHook("check-rust-clippy.sh", edit(file.project), env);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });
});

test("check-ts-types: プロジェクトの外のファイルは検査しない", () => {
  withProject("exit 0", ({ env, file }) => {
    const result = runHook("check-ts-types.sh", edit(file.other.replace(/\.rs$/, ".ts")), env);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });
});
