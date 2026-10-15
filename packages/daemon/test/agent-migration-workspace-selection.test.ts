import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureAgentMigrationIgnoreFile } from "#src/agent-migration/ignore-file";
import { AGENT_MIGRATION_IGNORE_SEED } from "#src/agent-migration/selection-rules";
import {
  AGENT_MIGRATION_IGNORE_FILE,
  selectAgentMigrationWorkspace,
  type AgentMigrationWorkspaceSelection,
} from "#src/agent-migration/workspace-selection";

// macOS tmpdir lives under /var, a symlink; resolve it so paths compare as written.
const tempRoot = realpathSync(tmpdir());
const roots: string[] = [];

const locked: string[] = [];

afterEach(async () => {
  await Promise.all(locked.splice(0).map((path) => chmod(path, 0o755)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Makes a directory unreadable for the rest of the test; restored before cleanup. */
async function lock(path: string) {
  locked.push(path);
  await chmod(path, 0o000);
}

// Permission bits do not stop root, so the unreadable-directory cases only hold for a normal user.
const asUser = process.getuid?.() === 0 ? test.skip : test;

async function workspace(files: Record<string, string>) {
  const root = await mkdtemp(join(tempRoot, "agent-migration-selection-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await Bun.write(join(root, path), content);
  }
  return root;
}

const paths = (selection: AgentMigrationWorkspaceSelection) =>
  selection.entries.map((entry) => entry.path);

test("selects regular files in a stable path order with their sizes", async () => {
  const root = await workspace({
    "b.txt": "bb",
    "MEMORY.md": "# memory",
    "notes/work-log.md": "log",
  });
  const selection = await selectAgentMigrationWorkspace(root);
  expect(selection.entries).toEqual([
    { path: "MEMORY.md", kind: "file", sizeBytes: 8 },
    { path: "b.txt", kind: "file", sizeBytes: 2 },
    { path: "notes/work-log.md", kind: "file", sizeBytes: 3 },
  ]);
});

test("skips regenerable directories at any depth and counts them by category", async () => {
  const root = await workspace({
    "src/app.ts": "x",
    "node_modules/pkg/index.js": "x",
    "web/.next/cache/a": "x",
    "py/__pycache__/m.pyc": "x",
    "rust/target/debug/bin": "x",
  });
  const selection = await selectAgentMigrationWorkspace(root);
  expect(paths(selection)).toEqual(["src/app.ts"]);
  expect(selection.excluded.regenerable).toEqual([
    { path: "node_modules", category: "thirdPartyDependencies" },
    { path: "py/__pycache__", category: "caches" },
    { path: "rust/target", category: "buildArtifacts" },
    { path: "web/.next", category: "buildArtifacts" },
  ]);
});

test("excludes secret files and credential directories, listing their paths only", async () => {
  const root = await workspace({
    ".env": "TOKEN=1",
    ".env.local": "TOKEN=2",
    "app/.env.production": "TOKEN=3",
    "config/client_secret.json": "{}",
    "config/aws-credentials": "x",
    "deploy/github-token.txt": "x",
    ".ssh/id_ed25519": "key",
    ".aws/config": "x",
    ".gnupg/pubring.kbx": "x",
    "environment.md": "not a dotenv file",
    "tokenizer.py": "not a token file",
  });
  const selection = await selectAgentMigrationWorkspace(root);
  expect(paths(selection)).toEqual(["environment.md", "tokenizer.py"]);
  expect(selection.excluded.secret).toEqual([
    ".aws",
    ".env",
    ".env.local",
    ".gnupg",
    ".ssh",
    "app/.env.production",
    "config/aws-credentials",
    "config/client_secret.json",
    "deploy/github-token.txt",
  ]);
});

test("leaves the runtimes' own storage and Sessions on the source Computer", async () => {
  const root = await workspace({
    "MEMORY.md": "m",
    ".builtin-runtime/auth.json": "{}",
    ".builtin-sessions/s.jsonl": "{}",
    ".pi-sessions/p.jsonl": "{}",
  });
  const selection = await selectAgentMigrationWorkspace(root);
  expect(paths(selection)).toEqual(["MEMORY.md"]);
  expect(selection.excluded.runtimeStorage).toEqual([
    ".builtin-runtime",
    ".builtin-sessions",
    ".pi-sessions",
  ]);
});

test("an ignored work directory of code is measured, not walked", async () => {
  const root = await workspace({
    [AGENT_MIGRATION_IGNORE_FILE]: "work\n",
    "MEMORY.md": "m",
    "work/repo/src/main.ts": "code",
    "work/repo/.git/HEAD": "ref",
    "work/repo/.env": "TOKEN=1",
  });
  const selection = await selectAgentMigrationWorkspace(root);
  expect(paths(selection)).toEqual([AGENT_MIGRATION_IGNORE_FILE, "MEMORY.md"]);
  expect(selection.excluded.ignored).toEqual([{ path: "work", fileCount: 3, sizeBytes: 14 }]);
  // Nothing inside an ignored path is examined, so its secrets are not listed one by one.
  expect(selection.excluded.secret).toEqual([]);
});

test("honors the ignore file's literal paths and keeps the always-moved files", async () => {
  const root = await workspace({
    [AGENT_MIGRATION_IGNORE_FILE]: [
      "# scratch output",
      "./scratch/",
      "big.bin",
      "*.log",
      "MEMORY.md",
      "/outside/of/workspace",
      "",
    ].join("\n"),
    "MEMORY.md": "m",
    "scratch/a.txt": "aaaa",
    "scratch/b.txt": "bb",
    "big.bin": "123456",
    "run.log": "kept: globs are not supported",
  });
  const selection = await selectAgentMigrationWorkspace(root);
  expect(paths(selection)).toEqual([AGENT_MIGRATION_IGNORE_FILE, "MEMORY.md", "run.log"]);
  expect(selection.excluded.ignored).toEqual([
    { path: "big.bin", fileCount: 1, sizeBytes: 6 },
    { path: "scratch", fileCount: 2, sizeBytes: 6 },
  ]);
});

test("accepts an absolute ignore path inside the workspace", async () => {
  const root = await workspace({ "keep.txt": "k", "drop/x.txt": "x" });
  await Bun.write(join(root, AGENT_MIGRATION_IGNORE_FILE), `${join(root, "drop")}\n`);
  const selection = await selectAgentMigrationWorkspace(root);
  expect(paths(selection)).toEqual([AGENT_MIGRATION_IGNORE_FILE, "keep.txt"]);
});

test("carries symlinks that stay inside the workspace and drops ones that escape it", async () => {
  const root = await workspace({ "notes/today.md": "t" });
  await symlink("notes/today.md", join(root, "today"));
  await symlink("../../etc/passwd", join(root, "escape"));
  await symlink("/etc/hosts", join(root, "absolute"));
  const selection = await selectAgentMigrationWorkspace(root);
  expect(selection.entries).toEqual([
    { path: "notes/today.md", kind: "file", sizeBytes: 1 },
    { path: "today", kind: "symlink", linkTarget: "notes/today.md" },
  ]);
  expect(selection.excluded.unsafeSymlinks).toEqual(["absolute", "escape"]);
});

test("reports a missing workspace instead of selecting nothing", async () => {
  await expect(
    selectAgentMigrationWorkspace(join(tempRoot, `missing-${crypto.randomUUID()}`)),
  ).rejects.toThrow(/workspace/i);
});

test("drops a symlink to the workspace root, which would loop", async () => {
  const root = await workspace({ "a.txt": "a" });
  await symlink(".", join(root, "self"));
  const selection = await selectAgentMigrationWorkspace(root);
  expect(paths(selection)).toEqual(["a.txt"]);
  expect(selection.excluded.unsafeSymlinks).toEqual(["self"]);
});

test("does not read an ignore file that is a symlink", async () => {
  const root = await workspace({ "keep.txt": "k", "list.txt": "keep.txt\n" });
  await symlink("list.txt", join(root, AGENT_MIGRATION_IGNORE_FILE));
  const selection = await selectAgentMigrationWorkspace(root);
  expect(paths(selection)).toContain("keep.txt");
  expect(selection.excluded.ignored).toEqual([]);
});

test("still lists a secret as a secret when the ignore file also names it", async () => {
  const root = await workspace({ [AGENT_MIGRATION_IGNORE_FILE]: ".env\n", ".env": "TOKEN=1" });
  const selection = await selectAgentMigrationWorkspace(root);
  expect(selection.excluded.secret).toEqual([".env"]);
  expect(selection.excluded.ignored).toEqual([]);
});

test("counts symlinks under an ignored path as files with no size", async () => {
  const root = await workspace({ [AGENT_MIGRATION_IGNORE_FILE]: "out\n", "out/a.txt": "aaa" });
  await symlink("a.txt", join(root, "out", "link"));
  const selection = await selectAgentMigrationWorkspace(root);
  expect(selection.excluded.ignored).toEqual([{ path: "out", fileCount: 2, sizeBytes: 3 }]);
});

asUser("records an unreadable directory and carries on", async () => {
  const root = await workspace({ "a.txt": "a", "private/b.txt": "b" });
  await lock(join(root, "private"));
  const selection = await selectAgentMigrationWorkspace(root);
  expect(paths(selection)).toEqual(["a.txt"]);
  expect(selection.excluded.unreadable).toEqual(["private"]);
});

asUser("records an unreadable directory under an ignored path and carries on", async () => {
  const root = await workspace({
    [AGENT_MIGRATION_IGNORE_FILE]: "scratch\n",
    "a.txt": "a",
    "scratch/x.txt": "x",
    "scratch/locked/y.txt": "y",
  });
  await lock(join(root, "scratch", "locked"));
  const selection = await selectAgentMigrationWorkspace(root);
  expect(paths(selection)).toEqual([AGENT_MIGRATION_IGNORE_FILE, "a.txt"]);
  expect(selection.excluded.ignored).toEqual([{ path: "scratch", fileCount: 1, sizeBytes: 1 }]);
  expect(selection.excluded.unreadable).toEqual(["scratch/locked"]);
});

test("before a migration, a workspace without an ignore file gets the default one", async () => {
  const root = await workspace({ "MEMORY.md": "m", "work/repo/a.ts": "code" });
  await ensureAgentMigrationIgnoreFile(root);
  expect(await readFile(join(root, AGENT_MIGRATION_IGNORE_FILE), "utf8")).toBe(
    AGENT_MIGRATION_IGNORE_SEED,
  );
  expect(paths(await selectAgentMigrationWorkspace(root))).toEqual([
    AGENT_MIGRATION_IGNORE_FILE,
    "MEMORY.md",
  ]);
});

test("before a migration, an existing ignore file is left exactly as the Agent wrote it", async () => {
  const root = await workspace({
    [AGENT_MIGRATION_IGNORE_FILE]: "big-data\n",
    "work/a.ts": "code",
  });
  await ensureAgentMigrationIgnoreFile(root);
  expect(await readFile(join(root, AGENT_MIGRATION_IGNORE_FILE), "utf8")).toBe("big-data\n");
  expect(paths(await selectAgentMigrationWorkspace(root))).toContain("work/a.ts");
});

test("never carries a migration's own commit marker from an earlier move", async () => {
  const root = await workspace({ "MEMORY.md": "m", ".coforge-migration/commit-v1.json": "{}" });
  const selection = await selectAgentMigrationWorkspace(root);
  expect(paths(selection)).toEqual(["MEMORY.md"]);
});
