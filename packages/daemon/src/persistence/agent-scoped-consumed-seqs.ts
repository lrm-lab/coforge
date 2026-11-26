import type { Database } from "bun:sqlite";
import {
  mergeSeenExactSeqs,
  normalizeSeenExactSeqs,
  threadRootTarget,
} from "@lrm/coforge-sdk/internal";
import { z } from "zod";
import type {
  AgentConsumedSeqEntry,
  AgentScopedConsumedSeqTarget,
} from "./agent-consumed-seq-store";

const positiveInteger = z.int().positive().optional().catch(undefined);
const identity = z.string().min(1);
const taskDiscussionTarget = z.string().regex(/^#[^:]+:#[1-9][0-9]*$/);
const scopedTargetSchema = z.object({
  target: identity,
  threadRootId: identity.optional(),
  entry: z.object({
    conversationId: identity,
    seq: positiveInteger,
    readOrder: positiveInteger,
    reviewedSeq: positiveInteger,
    exactSeqs: z.unknown().optional(),
  }),
});

type ScopedEvidenceEntry = AgentConsumedSeqEntry & { conversationId: string };
type ScopedEvidence = AgentScopedConsumedSeqTarget & { entry: ScopedEvidenceEntry };

type StoredConsumedRow = {
  target: string;
  conversation_id: string;
  thread_root_id?: string;
  seq: number | null;
  read_order: number | null;
  reviewed_seq: number | null;
  exact_seqs: string;
};

const SELECT_LEGACY = `SELECT target, conversation_id, seq, read_order, reviewed_seq, exact_seqs
  FROM consumed_seqs`;

const SELECT_SCOPED = `SELECT target, conversation_id, thread_root_id, seq, read_order,
  reviewed_seq, exact_seqs FROM scoped_consumed_seqs`;

const UPSERT_SCOPED = `INSERT INTO scoped_consumed_seqs
  (target, conversation_id, thread_root_id, seq, read_order, reviewed_seq, exact_seqs)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(conversation_id, thread_root_id) DO UPDATE SET
    target = excluded.target,
    seq = excluded.seq,
    read_order = excluded.read_order,
    reviewed_seq = excluded.reviewed_seq,
    exact_seqs = excluded.exact_seqs
  WHERE scoped_consumed_seqs.seq IS NOT excluded.seq
    OR scoped_consumed_seqs.read_order IS NOT excluded.read_order
    OR scoped_consumed_seqs.reviewed_seq IS NOT excluded.reviewed_seq
    OR scoped_consumed_seqs.exact_seqs IS NOT excluded.exact_seqs`;

function legacyThreadSuffix(target: string): string | undefined {
  const suffix = threadRootTarget(target);
  return suffix !== undefined && !taskDiscussionTarget.safeParse(target).success
    ? suffix
    : undefined;
}

export function legacyConsumedSeqProjection(
  target: string,
  conversationId: string,
  scopedTargets: readonly AgentScopedConsumedSeqTarget[],
): "upsert" | "clear" | "ignore" {
  const suffix = legacyThreadSuffix(target);
  const scopes = scopedTargets.filter(
    (row) => row.target === target && row.entry.conversationId === conversationId,
  );
  const matching = scopes.every((row) => row.threadRootId === suffix);
  if (suffix === undefined) return matching ? "upsert" : "ignore";
  return suffix.length > 0 && scopes.length > 0 && matching ? "upsert" : "clear";
}

function normalizeTarget(value: unknown): ScopedEvidence | undefined {
  const parsed = scopedTargetSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { target, threadRootId, entry } = parsed.data;
  if (threadRootId === undefined && legacyThreadSuffix(target) !== undefined) return undefined;

  const normalized = evidenceEntry(
    entry.conversationId,
    entry.seq ?? 0,
    entry.readOrder ?? 0,
    entry.reviewedSeq ?? 0,
    normalizeSeenExactSeqs(entry.exactSeqs, entry.seq ?? 0),
  );
  if (normalized.seq === undefined && normalized.readOrder === undefined && !normalized.exactSeqs)
    return undefined;
  return { target, ...(threadRootId !== undefined ? { threadRootId } : {}), entry: normalized };
}

function evidenceEntry(
  conversationId: string,
  seq: number,
  readOrder: number,
  reviewedSeq: number,
  exactSeqs: readonly number[],
): ScopedEvidenceEntry {
  return {
    conversationId,
    ...(seq > 0 ? { seq } : {}),
    ...(readOrder > 0 ? { readOrder } : {}),
    ...(readOrder > 0 && reviewedSeq > 0 ? { reviewedSeq } : {}),
    ...(exactSeqs.length > 0 ? { exactSeqs } : {}),
  };
}

function fromStoredRow(row: StoredConsumedRow): ScopedEvidence | undefined {
  let exactSeqs: unknown;
  try {
    exactSeqs = JSON.parse(row.exact_seqs);
  } catch {
    exactSeqs = undefined;
  }
  return normalizeTarget({
    target: row.target,
    threadRootId: row.thread_root_id === "" ? undefined : row.thread_root_id,
    entry: {
      conversationId: row.conversation_id,
      seq: row.seq,
      readOrder: row.read_order,
      reviewedSeq: row.reviewed_seq,
      exactSeqs,
    },
  });
}

function existingScopedEvidence(
  db: Database,
  conversationId: string,
  threadRootId = "",
): ScopedEvidenceEntry | undefined {
  const row = db
    .query<StoredConsumedRow, [string, string]>(
      `${SELECT_SCOPED} WHERE conversation_id = ? AND thread_root_id = ?`,
    )
    .get(conversationId, threadRootId);
  return row ? fromStoredRow(row)?.entry : undefined;
}

function upsert(
  db: Database,
  { target, threadRootId = "", entry }: ScopedEvidence,
  current: ScopedEvidenceEntry | undefined,
): void {
  const { conversationId } = entry;
  const seq = Math.max(entry.seq ?? 0, current?.seq ?? 0);
  const readOrder = Math.max(entry.readOrder ?? 0, current?.readOrder ?? 0);
  const reviewedSeq = Math.max(entry.reviewedSeq ?? 0, current?.reviewedSeq ?? 0);
  const exactSeqs = mergeSeenExactSeqs(seq, entry.exactSeqs ?? [], current?.exactSeqs ?? []);
  db.query(UPSERT_SCOPED).run(
    target,
    conversationId,
    threadRootId,
    seq || null,
    readOrder || null,
    reviewedSeq || null,
    JSON.stringify(exactSeqs),
  );
}

export function reconcileLegacyConsumedSeqs(db: Database): void {
  db.transaction(() => {
    for (const row of db.query<StoredConsumedRow, []>(SELECT_LEGACY).all()) {
      if (typeof row.target !== "string" || !row.target) continue;
      const threadRootId = legacyThreadSuffix(row.target);
      const scoped = fromStoredRow({
        ...row,
        ...(threadRootId !== undefined ? { thread_root_id: threadRootId } : {}),
      });
      if (!scoped) continue;
      const current = existingScopedEvidence(db, scoped.entry.conversationId, threadRootId);
      if (threadRootId !== undefined && !current) continue;
      upsert(db, scoped, current);
    }
  }).immediate();
}

export function readScopedConsumedSeqs(db: Database): AgentScopedConsumedSeqTarget[] {
  const targets: AgentScopedConsumedSeqTarget[] = [];
  for (const row of db
    .query<StoredConsumedRow, []>(`${SELECT_SCOPED} ORDER BY conversation_id, thread_root_id`)
    .all()) {
    const target = fromStoredRow(row);
    if (target) targets.push(target);
  }
  return targets;
}

export function upsertScopedConsumedSeqs(
  db: Database,
  rows: readonly AgentScopedConsumedSeqTarget[],
): void {
  for (const row of rows) {
    const target = normalizeTarget(row);
    if (!target) continue;
    const current = existingScopedEvidence(db, target.entry.conversationId, target.threadRootId);
    upsert(db, target, current);
  }
}
