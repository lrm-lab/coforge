import { ATTACHMENT_COMMENT_MIGRATION_TRANSACTION_TIMEOUT_MS } from "#src/server/attachments/attachment-comment-migration.server";
import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { attachmentCommentRehearsalFixture } from "./helpers/attachment-comment-rehearsal-fixture";

const CHILD_TIMEOUT_MS = 2 * ATTACHMENT_COMMENT_MIGRATION_TRANSACTION_TIMEOUT_MS + 10_000;
const TIMEOUT_MS = CHILD_TIMEOUT_MS + 10_000;
async function cli(args: string[], schema: string, overrides: Record<string, string> = {}) {
  const child = Bun.spawn({
    cmd: [process.execPath, "./scripts/attachment-comment-migration.ts", ...args],
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      DATABASE_URL: Bun.env.MIGRATION_TEST_DATABASE_URL!,
      ATTACHMENT_MIGRATION_COPY_DATABASE_URL: Bun.env.MIGRATION_TEST_DATABASE_URL!,
      ATTACHMENT_MIGRATION_SCHEMA: schema,
      ...overrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), CHILD_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
  }
}

test(
  "the maintenance CLI exports a read-only identifiers/counts plan",
  async () => {
    const f = await attachmentCommentRehearsalFixture();
    try {
      const before = await f.inventory();
      const result = await cli(["preflight"], f.schema);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "ready",
        counts: { attachments: 2, messages: 3 },
      });
      expect(result.stdout).not.toContain("An existing nested reply");
      expect(await f.inventory()).toEqual(before);
    } finally {
      await f.close();
    }
  },
  TIMEOUT_MS,
);

test(
  "the CLI rehearses and restores its explicit copy while keeping the full journal private",
  async () => {
    const f = await attachmentCommentRehearsalFixture();
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), "coforge-comment-cli-"));
      const journalPath = join(directory, "journal.json");
      const before = await f.inventory();
      const result = await cli(["rehearse", "--journal", journalPath], f.schema);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "restored",
        plan: { counts: { messages: 3 } },
      });
      expect(result.stdout).not.toContain("An existing nested reply");
      expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
      const journal = await Bun.file(journalPath).json();
      expect(journal).toMatchObject({ version: 1, scope: { schema: f.schema } });
      expect(JSON.stringify(journal)).toContain("An existing nested reply");
      expect(await f.inventory()).toEqual(before);
      const retry = await cli(["restore", "--journal", journalPath], f.schema);
      expect(retry.code).toBe(0);
      expect(await f.inventory()).toEqual(before);
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        await f.close();
      }
    }
  },
  TIMEOUT_MS,
);

test(
  "an existing journal is not overwritten or followed by a committed migration",
  async () => {
    const f = await attachmentCommentRehearsalFixture();
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), "coforge-comment-cli-"));
      const path = join(directory, "journal.json");
      await writeFile(path, "existing backup", { mode: 0o600, flag: "wx" });
      const before = await f.inventory();
      const result = await cli(["rehearse", "--journal", path], f.schema);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("already exists");
      expect(await Bun.file(path).text()).toBe("existing backup");
      expect(await f.inventory()).toEqual(before);
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        await f.close();
      }
    }
  },
  TIMEOUT_MS,
);

test(
  "copy writes reject a remote connection or a host override before connecting",
  async () => {
    for (const url of [
      "postgresql://fixture:private-value@example.invalid/copy",
      "postgresql://fixture:private-value@127.0.0.1/copy?host=example.invalid",
    ]) {
      const result = await cli(["rehearse", "--journal", "/unused.json"], "public", {
        ATTACHMENT_MIGRATION_COPY_DATABASE_URL: url,
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("local copy");
      expect(result.stderr).not.toContain("private-value");
      expect(result.stderr).not.toContain("example.invalid");
    }
  },
  TIMEOUT_MS,
);
