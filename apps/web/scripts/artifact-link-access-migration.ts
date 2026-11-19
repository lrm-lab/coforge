import { open } from "node:fs/promises";
import { dirname } from "node:path";
import {
  applyLinkAccessMigration,
  parseLinkAccessMigrationJournal,
  parseLinkAccessMigrationRecord,
  planLinkAccessMigration,
  rollbackLinkAccessMigration,
  type LinkAccessMigrationJournal,
} from "#src/server/artifacts/artifact-link-access-migration.server";
import { requireDatabaseClient } from "#src/server/db/client.server";

class UsageError extends Error {}

const USAGE = "Use dry-run, apply --journal <new-file>, or rollback --journal <file>";

function commandFrom(args: string[]) {
  const [command, flag, path] = args;
  if (command === "dry-run" && args.length === 1) return { command } as const;
  if (
    (command === "apply" || command === "rollback") &&
    args.length === 3 &&
    flag === "--journal" &&
    path
  )
    return { command, journalPath: path } as const;
  throw new UsageError(USAGE);
}

function database() {
  if (!Bun.env.DATABASE_URL) throw new UsageError("DATABASE_URL is required");
  return requireDatabaseClient();
}

async function syncDirectory(path: string) {
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function createJournal(path: string) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.write(`${JSON.stringify({ version: 1, appliedAt: new Date().toISOString() })}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(path);
}

async function readJournal(path: string): Promise<LinkAccessMigrationJournal> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0)
      throw new UsageError("The journal must be an owner-only regular file");
    const raw = await file.readFile("utf8");
    const lines = raw.split("\n").filter((line) => line !== "");
    if (lines.length === 0) throw new UsageError("The journal is empty");
    const torn = !raw.endsWith("\n");
    const records = lines.slice(1).flatMap((line, index) => {
      try {
        return [parseLinkAccessMigrationRecord(JSON.parse(line))];
      } catch {
        if (torn && index === lines.length - 2) return [];
        throw new UsageError(`The journal's record ${index + 1} is not usable`);
      }
    });
    let header: unknown;
    try {
      header = JSON.parse(lines[0] ?? "");
    } catch {
      throw new UsageError("The journal's header is not usable");
    }
    return parseLinkAccessMigrationJournal({ ...(header as object), records });
  } finally {
    await file.close();
  }
}

function describe(error: unknown) {
  if (error instanceof UsageError) return error.message;
  if (error instanceof Error)
    return { message: error.message, code: (error as { code?: string }).code };
  return "Link access migration failed";
}

async function main() {
  const command = commandFrom(Bun.argv.slice(2));
  const db = database();
  try {
    if (command.command === "dry-run") {
      const plan = await planLinkAccessMigration(db);
      console.log(
        `Would migrate ${plan.byFrom.conversation + plan.byFrom.workspace} artifacts: conversation ${plan.byFrom.conversation}, workspace ${plan.byFrom.workspace}; ${plan.alreadyLink} already link.`,
      );
      return;
    }
    if (command.command === "apply") {
      await createJournal(command.journalPath);
      const journal = await applyLinkAccessMigration(db, async (record) => {
        const file = await open(command.journalPath, "a", 0o600);
        try {
          await file.write(`${JSON.stringify(record)}\n`);
          await file.sync();
        } finally {
          await file.close();
        }
      });
      console.log(`Migrated ${journal.records.length} artifacts; journal ${command.journalPath}.`);
      return;
    }
    const journal = await readJournal(command.journalPath);
    const skipped = await rollbackLinkAccessMigration(db, journal);
    console.log(
      `Restored ${journal.records.length - skipped.length} artifacts, skipped ${skipped.length}${skipped.length ? `: ${skipped.join(", ")}` : ""}.`,
    );
    if (skipped.length > 0) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

try {
  await main();
} catch (error) {
  console.error(describe(error));
  process.exitCode = 1;
}
