import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_WORKSPACE_BACKUP_MAX_AGE_MS,
  pruneWorkspaceBackups,
} from "#src/agent-migration/workspace-backups";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const DAY = 24 * 60 * 60 * 1000;

test("an Agent keeps its three newest backups, none older than thirty days, and copies in progress", async () => {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "agent-migration-backups-"));
  roots.push(root);
  const now = Date.now();
  const make = async (name: string, ageDays: number) => {
    await mkdir(join(root, name, "notes"), { recursive: true });
    const at = new Date(now - ageDays * DAY);
    await utimes(join(root, name), at, at);
  };
  await make("source-a", 1);
  await make("preexisting-b", 2);
  await make("source-c", 3);
  await make("source-d", 4);
  await make("source-old", AGENT_WORKSPACE_BACKUP_MAX_AGE_MS / DAY + 1);
  await make("source-e.partial-1234", 40);
  await pruneWorkspaceBackups(root, now);
  expect((await readdir(root)).sort()).toEqual(
    ["preexisting-b", "source-a", "source-c", "source-e.partial-1234"].sort(),
  );
});
