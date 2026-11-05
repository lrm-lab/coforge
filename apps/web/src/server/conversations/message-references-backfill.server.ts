import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import {
  CHANNEL_REFERENCE_TOKEN_PATTERN,
  THREAD_REFERENCE_TOKEN_PATTERN,
} from "@lrm/coforge-sdk/internal/channel-references";
import { TASK_REFERENCE_TOKEN_PATTERN } from "@lrm/coforge-sdk/internal/task-references";
import { LIVE_TASK_WHERE } from "#src/server/tasks/task-view.server";
import { channelThreadRootsWhere } from "#src/server/db/message-anchor.server";

/** `message_references` backfill (task #465 step 2): history's stored tokens resolve to rows by
 * the ids they carry — `<@channel:uuid:name>`, `<@thread:ch:root:name>` and the three task forms —
 * the same `kind`/`targetId`/`raw`/`ordinal` a new send writes. Prose left in a body is a token
 * its send could not resolve; re-reading it now would guess, so prose counts only as
 * `unresolvedProse`. An apply run records its `(messageId, ordinal)` rows in
 * `message_reference_backfill_runs` so a `--rollback --run-id` deletes exactly those — never a
 * live send's rows that happen to share an id range and time window. */

export type BackfillReference =
  | { kind: "channel"; channelId: string }
  | { kind: "thread"; channelId: string; rootId: string }
  | { kind: "task"; conversationId: string; number: number };

export type BackfillCandidate = {
  reference: BackfillReference;
  /** The stored token text — the `raw` the row keeps, so a reader pairs the row and the token. */
  raw: string;
  ordinal: number;
};

/** Every stored reference token in `body`, in text order. Mentions are not references; prose
 * (`#name`) is not a token — neither produces a candidate. */
export function readBackfillReferences(body: string): BackfillCandidate[] {
  const found: { index: number; candidate: BackfillCandidate }[] = [];
  const collect = (pattern: RegExp, build: (match: RegExpExecArray) => BackfillReference) => {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
      const start = match.index;
      found.push({
        index: start,
        candidate: { reference: build(match), raw: match[0], ordinal: 0 },
      });
    }
  };
  collect(CHANNEL_REFERENCE_TOKEN_PATTERN, (match) => ({
    kind: "channel",
    channelId: match[1]!.toLowerCase(),
  }));
  collect(THREAD_REFERENCE_TOKEN_PATTERN, (match) => ({
    kind: "thread",
    channelId: match[1]!.toLowerCase(),
    rootId: match[2]!.toLowerCase(),
  }));
  collect(TASK_REFERENCE_TOKEN_PATTERN, (match) =>
    match[1]
      ? { kind: "task", conversationId: "", number: Number(match[1]) }
      : match[2]
        ? { kind: "task", conversationId: match[2]!.toLowerCase(), number: Number(match[4]) }
        : { kind: "task", conversationId: match[5]!.toLowerCase(), number: Number(match[7]) },
  );
  return found
    .sort((a, b) => a.index - b.index)
    .map((entry, ordinal) => ({ ...entry.candidate, ordinal }));
}

export type MessageReferenceBackfillOptions = {
  /** Called the moment an apply's ledger row exists, so the caller's own `finally` names the run. */
  onRunId?: (runId: string) => void | Promise<void>;
  /** Called after each batch with the live write count and cursor, so a crash's summary line is
   * never a stale snapshot — a dry-run never calls it (there are no rows). */
  onProgress?: (progress: { rowsWritten: number; cursor?: string }) => void | Promise<void>;
  fromMessageId?: string;
  batchSize?: number;
  maxMinutes?: number;
  pauseMs?: number;
  dryRun?: boolean;
  /** Runs in this Workspace — the dry-run/tests read it instead of every table in the DB. */
  workspaceId?: string;
};

export type MessageReferenceBackfillSummary = {
  scanned: number;
  /** Messages that wrote at least one row — includes `partial` ones where some tokens resolved
   * and some did not. */
  resolved: number;
  /** Messages whose every reference token resolved to no live target — a dead id or a name
   * mismatch. Resolved by the token's id, never by a current name. */
  failed: number;
  /** Messages where some tokens resolved and some did not — still counted in `resolved`. */
  partial: number;
  /** Bodies carrying `<@` but no reference token (they never write a row). Bodies without any `<@`
   * are pre-filtered before this count — they are not in `withoutReferences` either. */
  withoutReferences: number;
  /** Messages already carrying rows — a new send since step 1 wrote them; skipped. */
  alreadyWritten: number;
  /** `#name`-style prose left unwritten after stored tokens and @mentions are stripped — counted
   * only for bodies the `<@` pre-filter let through; a body with no token is never inspected. */
  unresolvedProse: number;
  rowsWritten: number;
  cursor?: string;
  timedOut: boolean;
  /** The `message_reference_backfill_runs` row this apply recorded — what `--rollback` names. */
  runRecordId?: string;
  /** The first message id the run covered. */
  firstId?: string;
  samples: { kind: string; ordinal: number; hash: string }[];
};

const DEFAULT_BATCH = 500;
const DEFAULT_MAX_MINUTES = 12;
const DEFAULT_PAUSE_MS = 100;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const hash = (raw: string) => createHash("sha256").update(raw).digest("hex").slice(0, 12);

/** Validate each candidate's id against the live tables and produce the `message_references`
 * rows, matching `writeMessageReferences`' `{kind, targetId, raw, ordinal}` shape. */
async function resolveBackfillReferences(
  db: Pick<PrismaClient, "conversation" | "message" | "task">,
  scope: { workspaceId: string; conversationId: string },
  candidates: BackfillCandidate[],
): Promise<{ kind: string; targetId: string; raw: string; ordinal: number }[]> {
  const channelIds = new Set<string>();
  const threadRoots = new Set<string>();
  const taskKeys = new Set<string>();
  for (const candidate of candidates) {
    const ref = candidate.reference;
    if (ref.kind === "channel") channelIds.add(ref.channelId);
    else if (ref.kind === "thread") threadRoots.add(`${ref.channelId}:${ref.rootId}`);
    else taskKeys.add(`${ref.conversationId || scope.conversationId}:${ref.number}`);
  }
  const conversations = channelIds.size
    ? await db.conversation.findMany({
        where: { workspaceId: scope.workspaceId, id: { in: [...channelIds] } },
        select: { id: true },
      })
    : [];
  const channelOk = new Set(conversations.map((row) => row.id));
  const threadKeys = [...threadRoots].map((key) => {
    const [channelId, rootId] = key.split(":");
    return { channelId: channelId!, rootId: rootId! };
  });
  // The thread's token carries its channel's id — the root must be a top-level message in that
  // channel (`channelThreadRootsWhere`'s rule); a root in another channel resolves nothing.
  const byChannel = new Map<string, string[]>();
  for (const key of threadKeys)
    byChannel.set(key.channelId, [...(byChannel.get(key.channelId) ?? []), key.rootId]);
  const messages = threadKeys.length
    ? await db.message.findMany({
        where: {
          workspaceId: scope.workspaceId,
          OR: [...byChannel.entries()].map(([channelId, roots]) =>
            channelThreadRootsWhere(channelId, roots),
          ),
        },
        select: { id: true, conversationId: true },
      })
    : [];
  const threadOk = new Set(messages.map((row) => `${row.conversationId}:${row.id}`));
  const taskOr = [...taskKeys].map((key) => {
    const [conversationId, number] = key.split(":");
    return { conversationId: conversationId!, number: Number(number) };
  });
  const tasks = taskOr.length
    ? await db.task.findMany({
        where: { workspaceId: scope.workspaceId, ...LIVE_TASK_WHERE, OR: taskOr },
        select: { id: true, conversationId: true, number: true },
      })
    : [];
  const taskByKey = new Map(tasks.map((row) => [`${row.conversationId}:${row.number}`, row.id]));
  const rows: { kind: string; targetId: string; raw: string; ordinal: number }[] = [];
  for (const candidate of candidates) {
    const ref = candidate.reference;
    if (ref.kind === "channel" && channelOk.has(ref.channelId))
      rows.push({
        kind: "channel",
        targetId: ref.channelId,
        raw: candidate.raw,
        ordinal: candidate.ordinal,
      });
    else if (ref.kind === "thread" && threadOk.has(`${ref.channelId}:${ref.rootId}`))
      rows.push({
        kind: "thread",
        targetId: ref.rootId,
        raw: candidate.raw,
        ordinal: candidate.ordinal,
      });
    else if (ref.kind === "task") {
      const conversationId = ref.conversationId || scope.conversationId;
      const taskId = taskByKey.get(`${conversationId}:${ref.number}`);
      if (taskId)
        rows.push({
          kind: "task",
          targetId: taskId,
          raw: candidate.raw,
          ordinal: candidate.ordinal,
        });
    }
  }
  return rows;
}

/** Prose reference candidates that never became a token — `#name`-style, after the stored tokens
 * and @mentions are stripped so a token's own text is never counted. */
const PROSE_REFERENCE = /#[a-z0-9][a-z0-9_-]*/gi;
const STRIP = /<@[a-z]+:[^>]+>|@[a-z0-9~_-]+/gi;
const unresolvedProseCount = (body: string) =>
  (body.replace(STRIP, " ").match(PROSE_REFERENCE) ?? []).length;

export async function backfillMessageReferences(
  db: PrismaClient,
  options: MessageReferenceBackfillOptions = {},
): Promise<MessageReferenceBackfillSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH;
  const maxMinutes = options.maxMinutes ?? DEFAULT_MAX_MINUTES;
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new Error("batch-size must be a positive integer");
  if (!(maxMinutes > 0)) throw new Error("max-minutes must be a positive number");
  if (options.fromMessageId && !/^[0-9a-f-]{36}$/i.test(options.fromMessageId))
    throw new Error("from-message-id must be a uuid");
  const pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;
  const deadline = Date.now() + maxMinutes * 60_000;
  const summary: MessageReferenceBackfillSummary = {
    scanned: 0,
    resolved: 0,
    failed: 0,
    partial: 0,
    withoutReferences: 0,
    alreadyWritten: 0,
    unresolvedProse: 0,
    rowsWritten: 0,
    timedOut: false,
    samples: [],
  };
  // The run row exists before its first batch — a crash mid-run still attributes every committed
  // row to it through `message_reference_backfill_rows`; `finishedAt` stamps in `finally`. The
  // caller learns the id the moment the row lands, so its own `finally` names the same run.
  let runRecordId: string | undefined;
  if (!options.dryRun) {
    const created = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO message_reference_backfill_runs (id, "startedAt", "fromId", written)
      VALUES (${crypto.randomUUID()}, now(), ${options.fromMessageId ?? null}, 0)
      RETURNING id
    `;
    runRecordId = created[0]!.id;
    summary.runRecordId = runRecordId;
    await options.onRunId?.(runRecordId);
  }
  let cursor = options.fromMessageId;
  let firstId: string | undefined;
  try {
    const workspaceWhere = options.workspaceId ? { workspaceId: options.workspaceId } : {};
    for (;;) {
      if (Date.now() >= deadline) {
        summary.timedOut = true;
        summary.cursor = cursor;
        break;
      }
      const messages = await db.message.findMany({
        where: {
          ...workspaceWhere,
          ...(cursor ? { id: { gt: cursor } } : {}),
          body: { contains: "<@", mode: "insensitive" },
        },
        orderBy: { id: "asc" },
        take: batchSize,
        select: {
          id: true,
          conversationId: true,
          workspaceId: true,
          body: true,
          _count: { select: { references: true } },
        },
      });
      if (!messages.length) break;
      for (const message of messages) {
        cursor = message.id;
        summary.scanned++;
        if (message._count.references > 0) {
          summary.alreadyWritten++;
          continue;
        }
        const candidates = readBackfillReferences(message.body);
        // Prose counts only after the stored tokens and any @mention are stripped — a `#name` the
        // send never made a token is a miss, never a row (the `<@` pre-filter already skipped
        // bodies with no token at all).
        summary.unresolvedProse += unresolvedProseCount(message.body);
        if (!candidates.length) {
          summary.withoutReferences++;
          continue;
        }
        const rows = await resolveBackfillReferences(
          db,
          { workspaceId: message.workspaceId, conversationId: message.conversationId },
          candidates,
        );
        if (!rows.length) {
          summary.failed++;
          continue;
        }
        let inserted = rows.length;
        if (!options.dryRun) {
          // Only rows this run actually inserted are attributed to it — a concurrent live send's
          // (messageId, ordinal) that skipped the conflict is never recorded, so a rollback never
          // deletes it. The insert and its child rows commit in ONE transaction: a child write that
          // fails rolls the batch's rows back with it rather than leaving committed, un-attributed
          // rows. A hard error (a dropped connection, a bad statement) aborts the run — it is not a
          // per-message failure the run should swallow and continue past.
          const tuples = rows.map(
            (row) =>
              Prisma.sql`(${message.id}::uuid, ${message.conversationId}::uuid, ${message.workspaceId}::uuid, ${row.kind}, ${row.targetId}::uuid, ${row.raw}, ${row.ordinal}, now())`,
          );
          const created = await db.$transaction(async (tx) => {
            const inserted = await tx.$queryRaw<{ messageId: string; ordinal: number }[]>`
            INSERT INTO message_references ("messageId", "conversationId", "workspaceId", kind, "targetId", raw, ordinal, "createdAt")
            VALUES ${Prisma.join(tuples)}
            ON CONFLICT DO NOTHING
            RETURNING "messageId", ordinal
          `;
            if (inserted.length)
              await tx.messageReferenceBackfillRow.createMany({
                data: inserted.map((row) => ({
                  runId: runRecordId!,
                  messageId: row.messageId,
                  ordinal: row.ordinal,
                })),
              });
            return inserted;
          });
          inserted = created.length;
        }
        // A token that resolved no row — a dead id, a name mismatch — makes the message partial:
        // some of its references landed and some never could.
        if (rows.length < candidates.length) summary.partial++;
        summary.resolved++;
        summary.rowsWritten += inserted;
        firstId ??= message.id;
        // The failures to sample are the candidates no row resolved — a dead id or a name mismatch —
        // not the rows that landed. kind, ordinal and a hash of the token, never its text.
        const resolvedTarget = new Set(rows.map((row) => `${row.kind}:${row.targetId}`));
        const unresolved = candidates.filter((candidate) => {
          const ref = candidate.reference;
          const target =
            ref.kind === "channel" ? ref.channelId : ref.kind === "thread" ? ref.rootId : undefined;
          return !target || !resolvedTarget.has(`${ref.kind}:${target}`);
        });
        if (summary.samples.length < 5)
          summary.samples.push(
            ...unresolved.slice(0, 5 - summary.samples.length).map((candidate) => ({
              kind: candidate.reference.kind,
              ordinal: candidate.ordinal,
              hash: hash(candidate.raw),
            })),
          );
      }
      if (pauseMs) await sleep(pauseMs);
    }
  } finally {
    // A timed-out, crashed, or errored run still stamps its end — the ledger row is how a cleanup
    // reads what the run covered; `finishedAt`/`toId`/`written` land whatever the reason it ended.
    if (runRecordId) {
      await db.$executeRaw`
        UPDATE message_reference_backfill_runs
        SET "finishedAt" = ${new Date()}, "toId" = ${cursor ?? null}, written = ${summary.rowsWritten}
        WHERE id = ${runRecordId}
      `;
    }
  }
  summary.firstId = firstId;
  return summary;
}

/** `--rollback --run-id`: delete exactly the `(messageId, ordinal)` rows the run recorded in
 * `message_reference_backfill_rows` — a live send's rows that shared its id range or window were
 * never attributed to it. Batched, capped, and safe to repeat: a re-run deletes only what is still
 * there. A `runId` no run recorded is an error, not a silent no-op. */
export async function rollbackMessageReferenceBackfill(
  db: PrismaClient,
  runId: string,
  options: { maxMinutes?: number; batchSize?: number } = {},
): Promise<{ deleted: number; remaining: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("run-id must be a uuid");
  const deadline = Date.now() + (options.maxMinutes ?? DEFAULT_MAX_MINUTES) * 60_000;
  const batchSize = options.batchSize ?? DEFAULT_BATCH;
  const run = await db.messageReferenceBackfillRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error(`no backfill run ${runId} — nothing to roll back`);
  let deleted = 0;
  let remaining = false;
  for (;;) {
    if (Date.now() >= deadline) {
      remaining = true;
      break;
    }
    const rows = await db.messageReferenceBackfillRow.findMany({
      where: { runId },
      take: batchSize,
      select: { messageId: true, ordinal: true },
    });
    if (!rows.length) break;
    // The message_references delete and its child bookkeeping commit together — a child delete
    // that fails does not leave orphaned ledger rows pointing at rows already gone.
    const result = await db.$transaction(async (tx) => {
      const deleted = await tx.messageReference.deleteMany({
        where: {
          OR: rows.map((row) => ({ messageId: row.messageId, ordinal: row.ordinal })),
        },
      });
      await tx.messageReferenceBackfillRow.deleteMany({
        where: {
          runId,
          OR: rows.map((row) => ({ messageId: row.messageId, ordinal: row.ordinal })),
        },
      });
      return deleted;
    });
    deleted += result.count;
  }
  return { deleted, remaining };
}
