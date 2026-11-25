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

const DELETE_OPEN_TARGET_SQL = `DELETE FROM continuations WHERE target = ? AND choice IS NULL`;
const DELETE_EXPIRED_SQL = `DELETE FROM continuations WHERE expires_at <= ?`;
const INSERT_CONTINUATION_SQL = `INSERT INTO continuations (id, target, payload, expires_at) VALUES (?, ?, ?, ?)`;
const SELECT_CONTINUATION_SQL = `SELECT payload, choice, with_input, answered_at FROM continuations WHERE id = ?`;
const DELETE_CONTINUATION_SQL = `DELETE FROM continuations WHERE id = ?`;
const MARK_ANSWERED_SQL = `UPDATE continuations SET choice = ?, with_input = ?, answered_at = ?
  WHERE id = ? AND choice IS NULL`;

export class AgentContinuationStore {
  constructor(
    private readonly db: AgentStateDb,
    private readonly now: () => number = Date.now,
  ) {}

  async create(continuation: AgentContinuation): Promise<void> {
    const db = this.db.database;
    const now = this.now();
    const payload = JSON.stringify(continuation);
    db.transaction(() => {
      db.query(DELETE_OPEN_TARGET_SQL).run(continuation.target);
      db.query(DELETE_EXPIRED_SQL).run(now);
      db.query(INSERT_CONTINUATION_SQL).run(
        continuation.id,
        continuation.target,
        payload,
        continuation.expiresAt,
      );
    })();
  }

  async lookup(id: string): Promise<AgentContinuationLookup> {
    const row = this.db.database.query(SELECT_CONTINUATION_SQL).get(id) as
      | ContinuationRow
      | undefined;
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
      this.db.database.query(DELETE_CONTINUATION_SQL).run(id);
      return { status: "expired", continuation };
    }
    return { status: "open", continuation };
  }

  async markAnswered(id: string, answer: AgentContinuationAnswer): Promise<boolean> {
    const result = this.db.database
      .query(MARK_ANSWERED_SQL)
      .run(answer.choice, answer.withInput ? 1 : 0, answer.answeredAt, id);
    return result.changes === 1;
  }
}
