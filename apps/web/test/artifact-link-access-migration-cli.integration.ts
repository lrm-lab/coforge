import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 30_000;

async function cli(args: string[]) {
  const child = Bun.spawn({
    cmd: [process.execPath, "./scripts/artifact-link-access-migration.ts", ...args],
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, DATABASE_URL: Bun.env.DATABASE_URL! },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

const header = `${JSON.stringify({ version: 1, appliedAt: new Date().toISOString() })}\n`;

test(
  "dry-run reports what it would migrate and changes nothing",
  async () => {
    const result = await cli(["dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Would migrate");
  },
  TIMEOUT_MS,
);

test("apply refuses a journal path that already exists, before it changes a row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "artifact-link-journal-"));
  try {
    const path = join(directory, "journal.jsonl");
    await writeFile(path, "kept\n", { mode: 0o600 });
    const result = await cli(["apply", "--journal", path]);
    expect(result.code).toBe(1);
    expect(await readFile(path, "utf8")).toBe("kept\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rollback refuses a journal anyone else can read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "artifact-link-journal-"));
  try {
    const path = join(directory, "journal.jsonl");
    await writeFile(path, header, { mode: 0o600 });
    await chmod(path, 0o644);
    const result = await cli(["rollback", "--journal", path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("owner-only");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rollback refuses a journal whose record in the middle is unusable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "artifact-link-journal-"));
  try {
    const path = join(directory, "journal.jsonl");
    await writeFile(path, `${header}{"artifactId":"not-a-uuid"}\n${header}`, { mode: 0o600 });
    const result = await cli(["rollback", "--journal", path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("record 1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rollback ignores a torn last line, the way a killed apply leaves one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "artifact-link-journal-"));
  try {
    const path = join(directory, "journal.jsonl");
    await writeFile(path, `${header}{"artifact`, { mode: 0o600 });
    expect((await stat(path)).mode & 0o077).toBe(0);
    const result = await cli(["rollback", "--journal", path]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Restored 0 artifacts, skipped 0");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rollback refuses a newline-terminated journal whose last record is unusable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "artifact-link-journal-"));
  try {
    const path = join(directory, "journal.jsonl");
    await writeFile(path, `${header}{"artifactId":"not-a-uuid"}\n`, { mode: 0o600 });
    const result = await cli(["rollback", "--journal", path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("record 1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
