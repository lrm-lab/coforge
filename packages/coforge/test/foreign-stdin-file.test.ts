import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An Agent once wrote its reply to a shared `/tmp/reply.txt` that another user owned: the write
// failed, and `coforge message send < /tmp/reply.txt` then sent that user's stale content. Every
// command that posts what it reads from stdin refuses such a file. These tests run the real CLI
// with stdin redirected from a file, as the shell does.
const CLI = join(import.meta.dir, "../src/cli.ts");
const FOREIGN_FILE = "/etc/hosts";
const SEND = ["message", "send", "--target", "@frank"];
const ACTION_PREPARE = ["action", "prepare", "--target", "#general"];
const directories: string[] = [];

afterAll(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function runWithStdinFrom(path: string, args: readonly string[]) {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    stdin: Bun.file(path),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: Bun.env.PATH ?? "" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("message send refuses a body redirected from a file another user owns", async () => {
  // The fixture is root-owned; a root test process would own it too and prove nothing.
  expect((await stat(FOREIGN_FILE)).uid).not.toBe(process.getuid!());

  const result = await runWithStdinFrom(FOREIGN_FILE, SEND);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("STDIN_FILE_NOT_OWNED");
  expect(result.stderr).toContain("Nothing was sent");
  expect(result.stderr).toContain("coforge message send --target \"@frank\" <<'COFORGE_MESSAGE'");
});

test("message send accepts a body redirected from the caller's own file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-send-stdin-"));
  directories.push(directory);
  const body = join(directory, "reply.txt");
  await writeFile(body, "hello\n");

  const result = await runWithStdinFrom(body, SEND);

  // No daemon is listening, so the send still fails, but past the ownership check.
  expect(result.stderr).not.toContain("STDIN_FILE_NOT_OWNED");
});

test("action prepare refuses an action redirected from a file another user owns", async () => {
  expect((await stat(FOREIGN_FILE)).uid).not.toBe(process.getuid!());

  const result = await runWithStdinFrom(FOREIGN_FILE, ACTION_PREPARE);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("STDIN_FILE_NOT_OWNED");
  expect(result.stderr).toContain("Nothing was sent");
  expect(result.stderr).toContain("coforge action prepare --target \"#general\" <<'COFORGEACTION'");
});
