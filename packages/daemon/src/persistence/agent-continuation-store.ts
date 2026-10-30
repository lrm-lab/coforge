import type { AgentStateDb } from "./agent-state-db";
import type { AgentMessageDraft } from "./agent-message-draft-store";

/**
 * One held send's open question — which of the offered choices the Agent picked. The row carries
 * the draft-shaped payload so the answer stays self-contained; the draft row itself remains the
 * resend's single owner (a later hold already replaced it under the same target).
 */
export type AgentContinuation = Readonly<{
  id: string;
  target: string;
  /** The held draft as it stood at the hold: `content`, `attachmentIds`, `idempotencyKey`,
   * `mentions`, `reholdCount`, `seenUpToSeq`, `seenExactSeqs`. */
  draft: Omit<AgentMessageDraft, "target" | "savedAt">;
  /** Whether choice `d` (send anyway) was offered — the server's `continueAnywaySuggested`. */
  anywayOffered: boolean;
  createdAt: number;
  expiresAt: number;
}>;

export type AgentContinuationChoice = "a" | "b" | "c" | "d";

export type AgentContinuationAnswer = Readonly<{
  choice: AgentContinuationChoice;
  /** Whether the answer carried input (choice `b`'s replacement body). */
  withInput: boolean;
  answeredAt: number;
}>;

export type AgentContinuationLookup =
  | { status: "open"; continuation: AgentContinuation }
  | { status: "answered"; continuation: AgentContinuation; answer: AgentContinuationAnswer }
  | { status: "missing" }
  | { status: "expired"; continuation: AgentContinuation };

type ContinuationRow = {
  payload: string;
  choice: string | null;
  with_input: number | null;
  answered_at: number | null;
};

/** The continuation row's lifetime — the same ten minutes its draft gets, so the question cannot
 * outlive the resend path it names. */
export const AGENT_CONTINUATION_TTL_MS = 10 * 60 * 1_000;

/**
 * Open and answered continuations, one row each in the Agent's `state.db`
 * (`agent-state/<agentId>/`) — the same database the draft and consumed cursor keep, each write its
 * own commit. An answered row is the tombstone: it stays until `expiresAt` so a repeat answer
 * reports what it already chose rather than "unknown". A new continuation for a target supersedes
 * that target's still-open ones — their draft was just replaced, so answering them could only
 * mislead.
 */
export class AgentContinuationStore {
  constructor(
    private readonly db: AgentStateDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** A held send's fresh continuation; prior open ones for the same target are superseded. */
  async create(continuation: AgentContinuation): Promise<void> {
    this.db.database
      .prepare(`DELETE FROM continuations WHERE target = ? AND choice IS NULL`)
      .run(continuation.target);
    // Lazy GC: an expired row's answer can no longer mean anything — open or tombstoned.
    this.db.database.prepare(`DELETE FROM continuations WHERE expires_at <= ?`).run(this.now());
    this.db.database
      .prepare(`INSERT INTO continuations (id, target, payload, expires_at) VALUES (?, ?, ?, ?)`)
      .run(
        continuation.id,
        continuation.target,
        JSON.stringify(continuation),
        continuation.expiresAt,
      );
  }

  async lookup(id: string): Promise<AgentContinuationLookup> {
    const row = this.db.database
      .prepare(`SELECT payload, choice, with_input, answered_at FROM continuations WHERE id = ?`)
      .get(id) as ContinuationRow | undefined;
    if (!row) return { status: "missing" };
    const continuation = JSON.parse(row.payload) as AgentContinuation;
    if (row.choice !== null)
      return {
        status: "answered",
        continuation,
        answer: {
          choice: row.choice as AgentContinuationChoice,
          withInput: row.with_input === 1,
          answeredAt: row.answered_at ?? 0,
        },
      };
    if (continuation.expiresAt <= this.now()) {
      this.db.database.prepare(`DELETE FROM continuations WHERE id = ?`).run(id);
      return { status: "expired", continuation };
    }
    return { status: "open", continuation };
  }

  /**
   * Records the answer in the same write that returns it, so a second answer — however it
   * arrived — reads the first one's choice rather than running twice. Returns false when the row
   * was already answered (or gone); the caller re-looks it up to report the winning answer.
   */
  async markAnswered(id: string, answer: AgentContinuationAnswer): Promise<boolean> {
    const result = this.db.database
      .prepare(
        `UPDATE continuations SET choice = ?, with_input = ?, answered_at = ?
           WHERE id = ? AND choice IS NULL`,
      )
      .run(answer.choice, answer.withInput ? 1 : 0, answer.answeredAt, id);
    return result.changes === 1;
  }
}
