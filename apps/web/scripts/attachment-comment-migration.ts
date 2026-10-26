import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AttachmentCommentMigration } from "#src/server/attachments/attachment-comment-migration.server";
import { PrismaAttachmentCommentMigrationStore } from "#src/server/db/repositories/attachment-comment-migration.repositories.server";
import {
  readAttachmentCommentJournal,
  writeAttachmentCommentJournal,
} from "./attachment-comment-migration-files";

class UsageError extends Error {}
const safeErrors = new Set([
  "Migration preflight is blocked",
  "Invalid local copy migration journal",
  "Journal must be an owner-only regular file",
  "Explicit local copy authorization is required",
  "Database is not the authorized local copy",
  "Journal belongs to a different local copy",
  "Local copy changed: rollback cannot overwrite new writes",
  "Local copy changed: unexpected dependency or new writes",
]);

function argumentsForMaintenance(args: string[]) {
  const command = args[0];
  if (command !== "preflight" && command !== "rehearse" && command !== "restore")
    throw new UsageError(
      "Use preflight, rehearse --journal <new-file>, or restore --journal <file>",
    );
  if (command === "preflight") {
    if (args.length !== 1) throw new UsageError("preflight takes no arguments");
    return { command } as const;
  }
  if (args.length !== 3 || args[1] !== "--journal" || !args[2])
    throw new UsageError("A private --journal file is required");
  return { command, journal: args[2] } as const;
}
function databaseForMaintenance(copy: boolean) {
  const schema = Bun.env.ATTACHMENT_MIGRATION_SCHEMA ?? "public";
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(schema))
    throw new UsageError("Invalid migration schema name");
  const connectionString = copy
    ? Bun.env.ATTACHMENT_MIGRATION_COPY_DATABASE_URL
    : Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new UsageError(
      copy ? "A local copy database URL is required" : "DATABASE_URL is required",
    );
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new UsageError("Invalid database URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new UsageError("Invalid database URL");
  const database = decodeURIComponent(url.pathname.slice(1));
  if (
    copy &&
    (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      ["host", "hostaddr", "options", "service", "dbname"].some((key) =>
        url.searchParams.has(key),
      ) ||
      !(
        database.startsWith("coforge_attachment_rehearsal_") ||
        schema.startsWith("attachment_rehearsal_")
      ))
  ) {
    throw new UsageError("Invalid local copy connection");
  }
  return { connectionString, schema, localCopy: copy ? { database, schema } : undefined };
}
async function main() {
  const args = argumentsForMaintenance(Bun.argv.slice(2));
  const options = databaseForMaintenance(args.command !== "preflight");
  const db = new PrismaClient({
    adapter: new PrismaPg(
      {
        connectionString: options.connectionString,
        options: `-c search_path=${options.schema},public`,
        connectionTimeoutMillis: 5_000,
      },
      { schema: options.schema },
    ),
  });
  try {
    const migration = new AttachmentCommentMigration(
      new PrismaAttachmentCommentMigrationStore(db, { localCopy: options.localCopy }),
    );
    if (args.command === "preflight") {
      const plan = await migration.preflight();
      console.log(JSON.stringify(plan));
      if (plan.status === "blocked") process.exitCode = 2;
    } else if (args.command === "rehearse") {
      const report = await migration.rehearseLocalCopy({
        persistJournal: (journal) => writeAttachmentCommentJournal(args.journal, journal),
      });
      console.log(JSON.stringify(report));
    } else {
      await migration.restoreLocalCopy(await readAttachmentCommentJournal(args.journal));
      console.log(JSON.stringify({ status: "restored" }));
    }
  } finally {
    await db.$disconnect();
  }
}

try {
  await main();
} catch (error) {
  const exists =
    typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
  const message =
    error instanceof UsageError
      ? error.message
      : exists
        ? "Journal already exists; it was not overwritten"
        : error instanceof Error && safeErrors.has(error.message)
          ? error.message
          : "Migration failed; keep the private journal if one was written";
  // Raw driver errors may contain a failing row. Reports never include them or the connection URL.
  console.error(message);
  process.exitCode = 1;
}
