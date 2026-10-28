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
};

/**
 * Short-lived continuation state, one row per target in the Agent's `state.db`
 * (`agent-state/<agentId>/`) — the same database the consumed cursor keeps, each write its own
 * commit.
 *
 * Only a lookup removes an expired row, and only its own target's: `--send-draft` can then tell
 * an expired draft from one that never existed, and a write for one target never drops another
 * target's expired draft (or its last body). The async signatures stay: the state machine's API
 * is unchanged, and each operation is already a single commit, so there is nothing left to
 * serialize by hand.
 */
export class AgentMessageDraftStore {
  constructor(
    private readonly db: AgentStateDb,
    private readonly now: () => number = Date.now,
  ) {}

  async lookup(target: string): Promise<AgentMessageDraftLookup> {
    const row = this.#row(target);
    if (!row) return { status: "missing" };
    const draft = this.#draft(row);
    // A row without a key names no logical send, so it answers exactly like an absent one.
    if (!draft.idempotencyKey) return { status: "missing" };
    if (!this.#expired(draft)) return { status: "found", draft };
    this.db.database.prepare(`DELETE FROM drafts WHERE target = ?`).run(target);
    return { status: "expired", content: draft.content, savedAt: draft.savedAt };
  }

  /** A fresh send saves a never-held draft; only `replace` (a hold) advances the count. */
  async save(target: string, draft: AgentMessageDraftContent): Promise<void> {
    this.#upsert(target, draft, 0);
  }

  /** The held-draft refresh: the same content, one hold later, at the reviewed frontier. */
  async replace(
    target: string,
    draft: AgentMessageDraftContent & { reholdCount: number },
  ): Promise<void> {
    this.#upsert(target, draft, draft.reholdCount);
  }

  async clear(target: string): Promise<void> {
    this.db.database.prepare(`DELETE FROM drafts WHERE target = ?`).run(target);
  }

  /** The clear after an accepted send: only the send whose key the draft holds consumes it, so an
   * older send accepted late never removes a newer draft. Returns whether it cleared. */
  async clearIfIdempotencyKeyMatches(target: string, idempotencyKey: string): Promise<boolean> {
    const row = this.#row(target);
    if (!row) return false;
    const draft = this.#draft(row);
    // An expired draft is left for `--send-draft` to report (and hand back) as expired.
    if (this.#expired(draft) || draft.idempotencyKey !== idempotencyKey) return false;
    this.db.database.prepare(`DELETE FROM drafts WHERE target = ?`).run(target);
    return true;
  }

  #row(target: string): DraftRow | undefined {
    return this.db.database.prepare(`SELECT * FROM drafts WHERE target = ?`).get(target) as
      | DraftRow
      | undefined;
  }

  #draft(row: DraftRow): AgentMessageDraft {
    const attachmentIds = parseJson<string[]>(row.attachment_ids) ?? [];
    const mentions = parseJson<LocalMentionSelector[]>(row.mentions) ?? [];
    const seenExactSeqs = normalizeSeenExactSeqs(
      parseJson<number[]>(row.seen_exact_seqs) ?? [],
      row.seen_up_to_seq ?? 0,
    );
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
    };
  }

  #upsert(target: string, draft: AgentMessageDraftContent, reholdCount: number): void {
    // A draft without a key names no logical send, so there is nothing to keep for a resend.
    if (!draft.idempotencyKey) return;
    this.db.database
      .prepare(
        `INSERT OR REPLACE INTO drafts
           (target, content, attachment_ids, idempotency_key, mentions, saved_at, rehold_count,
            seen_up_to_seq, seen_exact_seqs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
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
