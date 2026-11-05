import { requireDatabaseClient } from "../src/server/db/client.server";
import {
  backfillMessageReferences,
  rollbackMessageReferenceBackfill,
} from "../src/server/conversations/message-references-backfill.server";

/**
 * `message_references` backfill (task #465 step 2): history's stored reference tokens resolve to
 * rows by the ids they carry, under the same kind/targetId/raw/ordinal a new send writes. Prose
 * left in a body is a send-time miss and counts only as `unresolvedProse`. Every apply records its
 * `(messageId, ordinal)` rows in `message_reference_backfill_runs`, so `--rollback --run-id`
 * deletes exactly those — never a live send's rows that shared its id range or time window.
 *
 *   --dry-run              writes nothing; per-message counts + redacted samples
 *   --apply                writes and records the run
 *   --rollback --run-id <uuid>
 *                          deletes exactly the rows that run recorded
 *   --from-message-id <uuid>
 *                          resume from this `Message.id` (printed on a timed-out run)
 *   --batch-size <n>       messages per batch (default 500, validated positive int)
 *   --max-minutes <n>      stop after this many minutes (default 12, under the job's 15)
 *   --pause-ms <n>         pause between batches (default 100)
 *   --workspace-id <uuid>  scope to one Workspace (tests; default scans all)
 *
 * Every run prints its runId, start/end times, first/last message id and written count in a
 * `finally`, so a crash still leaves a ledger. Exactly one of --dry-run/--apply/--rollback.
 */
function usage(): never {
  throw new Error(
    "usage: --dry-run | --apply | --rollback --run-id <uuid>" +
      " [--from-message-id <uuid>] [--batch-size <n>] [--max-minutes <n>] [--pause-ms <n>]" +
      " [--workspace-id <uuid>]",
  );
}

const argv = Bun.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const modes = ["--dry-run", "--apply", "--rollback"].filter((mode) => argv.includes(mode));
if (modes.length !== 1) usage();
const mode = modes[0]!;
const numberFlag = (name: string, min = 1) => {
  const value = flag(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min)
    throw new Error(
      `${name} must be ${min === 0 ? "a non-negative" : "a positive"} number, got ${value}`,
    );
  return parsed;
};
const uuidFlag = (name: string) => {
  const value = flag(name);
  if (value === undefined) return undefined;
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error(`${name} must be a uuid, got ${value}`);
  return value;
};

const db = requireDatabaseClient();
const startedAt = new Date();
let lastCursor: string | undefined;
// The ledger id — the only runId the run reports — printed in `finally` so a crash still leaves
// the id a `--rollback --run-id` needs alongside the written count and the resume cursor.
let ledgerRunId: string | undefined;
let ledgerWritten = 0;
let firstId: string | undefined;
try {
  if (mode === "--rollback") {
    const id = uuidFlag("--run-id");
    if (!id) usage();
    const result = await rollbackMessageReferenceBackfill(db, id, {
      maxMinutes: numberFlag("--max-minutes"),
      batchSize: numberFlag("--batch-size"),
    });
    console.log(JSON.stringify({ event: "message_references_rollback", runId: id, ...result }));
    ledgerRunId = id;
    if (result.remaining) {
      console.error(
        `Rollback reached the time cap with rows left — run it again: --rollback --run-id ${id}`,
      );
      process.exitCode = 1;
    }
  } else {
    const summary = await backfillMessageReferences(db, {
      dryRun: mode === "--dry-run",
      fromMessageId: uuidFlag("--from-message-id"),
      workspaceId: uuidFlag("--workspace-id"),
      batchSize: numberFlag("--batch-size"),
      maxMinutes: numberFlag("--max-minutes"),
      pauseMs: numberFlag("--pause-ms", 0),
      onRunId: (id) => {
        ledgerRunId = id;
      },
      onProgress: ({ rowsWritten, cursor }) => {
        ledgerWritten = rowsWritten;
        if (cursor) lastCursor = cursor;
      },
    });
    lastCursor = summary.cursor;
    ledgerRunId = summary.runRecordId;
    ledgerWritten = summary.rowsWritten;
    firstId = summary.firstId;
    console.log(
      JSON.stringify({
        event: "message_references_backfill",
        runId: summary.runRecordId,
        dryRun: mode === "--dry-run",
        resume: summary.cursor ? `--from-message-id ${summary.cursor}` : undefined,
        rollback: summary.runRecordId ? `--rollback --run-id ${summary.runRecordId}` : undefined,
        ...summary,
      }),
    );
  }
} finally {
  console.log(
    JSON.stringify({
      event: "message_references_backfill_meta",
      runId: ledgerRunId,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      firstId,
      lastCursor,
      rowsWritten: ledgerWritten,
    }),
  );
  await db.$disconnect();
}
