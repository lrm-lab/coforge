import { requireDatabaseClient } from "../src/server/db/client.server";
import { backfillForwardSenders } from "../src/server/apps/forward-sender-backfill.server";

/**
 * One-time backfill for task #78 release two: fill `message_forwards.workspaceId` and
 * `senderUserId` for rows written without them (a rolling deploy's old instances, or rows the
 * deleted backfill migration never reached). Repeatable — the scan's WHERE is the rows still
 * missing `workspaceId`, walked in `messageId` keyset order, so a rerun continues and fills
 * nothing twice; `--after <messageId>` resumes where an earlier run's `lastMessageId` stopped.
 *
 *   --dry-run              writes nothing; prints the counts it would fill and skip
 *   --apply                writes
 *   --after <messageId>    optional; resume after this messageId (with either mode)
 *
 * Exactly one mode is required.
 */
function usage(): never {
  throw new Error("usage: --dry-run | --apply [--after <messageId>]");
}

const argv = Bun.argv.slice(2);
const modes = ["--dry-run", "--apply"].filter((flag) => argv.includes(flag));
if (modes.length !== 1) usage();
const mode = modes[0]!;
const afterIndex = argv.indexOf("--after");
const afterMessageId = afterIndex >= 0 ? argv[afterIndex + 1] : undefined;
if (afterIndex >= 0 && (!afterMessageId || afterMessageId.startsWith("--"))) usage();

const db = requireDatabaseClient();
try {
  const summary = await backfillForwardSenders({
    db,
    dryRun: mode === "--dry-run",
    afterMessageId,
  });
  console.log(
    JSON.stringify({ event: "forward_sender_backfill", dryRun: mode === "--dry-run", ...summary }),
  );
} finally {
  await db.$disconnect();
}
