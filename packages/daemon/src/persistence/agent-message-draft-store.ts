import {
  agentConsumptionScopeSchema,
  type AgentConsumptionScope,
} from "@lrm/coforge-sdk/internal/agent-consumption";
import { normalizeSeenExactSeqs, type LocalMentionSelector } from "@lrm/coforge-sdk/internal";
import { AgentStateDb } from "./agent-state-db";

export const AGENT_MESSAGE_DRAFT_TTL_MS = 10 * 60 * 1_000;

/**
 * The continuation state of one held send — the fields the draft row holds: `content`,
 * `attachmentIds`, `idempotencyKey`, `mentions`, `savedAt`, `reholdCount`, `seenUpToSeq`, and
 * `seenExactSeqs`.
 */
export type AgentMessageDraftContent = Readonly<{
  content: string;
  attachmentIds?: readonly string[];
  /** The idempotency key of the logical send this draft belongs to. Every send of the draft
   * (`--send-draft`, the same-key replay after a reconciliation) reuses it, so the server can never
   * commit the same logical send twice. An entry without one names no send and reads as missing. */
  idempotencyKey: string;
  mentions?: readonly LocalMentionSelector[];
  /** `seenUpToSeq`: the reviewed frontier this draft already accounts for. Carried into the
   * resend so the context the held notice presented is not presented — or held — twice. */
  seenUpToSeq?: number;
  /** `seenExactSeqs`: the messages above `seenUpToSeq` the Agent was shown one by one. Only a
   * held refresh whose context was withheld keeps them: a presented hold's frontier covers them,
   * and before a send they are already durable in the consumed cursor. */
  seenExactSeqs?: readonly number[];
  consumptionScope?: AgentConsumptionScope;
}>;

export type AgentMessageDraft = AgentMessageDraftContent &
  Readonly<{
    target: string;
    /** How many times this draft has already been held. Reported to the server as
     * `draftReholdCount`, which is what makes `continueAnywaySuggested` true. */
    reholdCount: number;
    savedAt: number;
  }>;

/** What a lookup found for one target. An expired draft is reported once, with its last body, and
 * removed; a later lookup reports it `missing`. */
export type AgentMessageDraftLookup =
  | { status: "found"; draft: AgentMessageDraft }
  | { status: "missing" }
  | { status: "expired"; content: string; savedAt: number };

type DraftRow = {
  target: string;
  content: string;
  attachment_ids: string | null;
  idempotency_key: string;
  mentions: string | null;
  saved_at: number;
  rehold_count: number;
  seen_up_to_seq: number | null;
  seen_exact_seqs: string | null;
  consumption_scope: string | null;
};

const SELECT_DRAFT_SQL = `SELECT * FROM drafts WHERE target = ?`;
const DELETE_DRAFT_SQL = `DELETE FROM drafts WHERE target = ?`;
const DELETE_DRAFT_IF_MATCH_SQL = `DELETE FROM drafts WHERE target = ? AND idempotency_key = ? AND saved_at >= ?`;
const UPSERT_DRAFT_SQL = `INSERT OR REPLACE INTO drafts
  (target, content, attachment_ids, idempotency_key, mentions, saved_at, rehold_count,
   seen_up_to_seq, seen_exact_seqs, consumption_scope)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export class AgentMessageDraftStore {
  constructor(
    private readonly db: AgentStateDb,
    private readonly now: () => number = Date.now,
  ) {}

  async lookup(target: string): Promise<AgentMessageDraftLookup> {
    const row = this.#row(target);
    if (!row) return { status: "missing" };
    const draft = this.#draft(row);
    if (!draft.idempotencyKey) return { status: "missing" };
    if (!this.#expired(draft)) return { status: "found", draft };
    this.db.database.query(DELETE_DRAFT_SQL).run(target);
    return { status: "expired", content: draft.content, savedAt: draft.savedAt };
  }

  async save(target: string, draft: AgentMessageDraftContent): Promise<void> {
    this.#upsert(target, draft, 0);
  }

  async replace(
    target: string,
    draft: AgentMessageDraftContent & { reholdCount: number },
  ): Promise<void> {
    this.#upsert(target, draft, draft.reholdCount);
  }

  async clear(target: string): Promise<void> {
    this.db.database.query(DELETE_DRAFT_SQL).run(target);
  }

  discard(
    target: string,
    expectedIdempotencyKey?: string,
  ):
    | { status: "missing" }
    | { status: "mismatch" }
    | { status: "discarded"; idempotencyKey: string } {
    const row = this.#row(target);
    if (!row) return { status: "missing" };
    const draft = this.#draft(row);
    if (!draft.idempotencyKey) return { status: "missing" };
    if (this.#expired(draft)) {
      this.db.database.query(DELETE_DRAFT_SQL).run(target);
      return { status: "missing" };
    }
    if (expectedIdempotencyKey !== undefined && draft.idempotencyKey !== expectedIdempotencyKey) {
      return { status: "mismatch" };
    }
    this.db.database.query(DELETE_DRAFT_SQL).run(target);
    return { status: "discarded", idempotencyKey: draft.idempotencyKey };
  }

  async clearIfIdempotencyKeyMatches(target: string, idempotencyKey: string): Promise<boolean> {
    const minSavedAt = this.now() - AGENT_MESSAGE_DRAFT_TTL_MS;
    const result = this.db.database
      .query(DELETE_DRAFT_IF_MATCH_SQL)
      .run(target, idempotencyKey, minSavedAt);
    return result.changes === 1;
  }

  #row(target: string): DraftRow | undefined {
    return this.db.database.query(SELECT_DRAFT_SQL).get(target) as DraftRow | undefined;
  }

  #draft(row: DraftRow): AgentMessageDraft {
    const attachmentIds = parseJson<string[]>(row.attachment_ids) ?? [];
    const mentions = parseJson<LocalMentionSelector[]>(row.mentions) ?? [];
    const seenExactSeqs = normalizeSeenExactSeqs(
      parseJson<number[]>(row.seen_exact_seqs) ?? [],
      row.seen_up_to_seq ?? 0,
    );
    const consumptionScope = parseConsumptionScope(row.consumption_scope);
    return {
      target: row.target,
      content: row.content,
      idempotencyKey: row.idempotency_key,
      reholdCount: row.rehold_count,
      savedAt: row.saved_at,
      ...(attachmentIds.length ? { attachmentIds } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(row.seen_up_to_seq !== null ? { seenUpToSeq: row.seen_up_to_seq } : {}),
      ...(seenExactSeqs.length ? { seenExactSeqs } : {}),
      ...(consumptionScope ? { consumptionScope } : {}),
    };
  }

  #upsert(target: string, draft: AgentMessageDraftContent, reholdCount: number): void {
    if (!draft.idempotencyKey) return;
    this.db.database
      .query(UPSERT_DRAFT_SQL)
      .run(
        target,
        draft.content,
        draft.attachmentIds?.length ? JSON.stringify(draft.attachmentIds) : null,
        draft.idempotencyKey,
        draft.mentions?.length ? JSON.stringify(draft.mentions) : null,
        this.now(),
        reholdCount,
        draft.seenUpToSeq ?? null,
        draft.seenExactSeqs?.length ? JSON.stringify(draft.seenExactSeqs) : null,
        draft.consumptionScope ? JSON.stringify(draft.consumptionScope) : null,
      );
  }

  #expired(draft: AgentMessageDraft): boolean {
    return this.now() - draft.savedAt > AGENT_MESSAGE_DRAFT_TTL_MS;
  }
}

function parseJson<T>(value: string | null): T | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

function parseConsumptionScope(value: string | null): AgentConsumptionScope | undefined {
  if (value === null) return undefined;
  try {
    return agentConsumptionScopeSchema.safeParse(JSON.parse(value)).data;
  } catch {
    return undefined;
  }
}
