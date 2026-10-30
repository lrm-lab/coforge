import type { Database } from "bun:sqlite";
import { readMeta, writeMeta } from "./agent-state-db";

/** What the ledger remembers having shown the Agent: a sender's description (`sender`) or a
 * channel's role line (`channel`). */
export type ContextObservationKind = "sender" | "channel";

const GENERATION_KEY = "contextGeneration";

/**
 * What one Agent has already been shown in its current context, so a sender's description and a
 * channel's role line appear once instead of on every message (modeled on Raft's observations
 * ledger). The context is a counter, `generation`: a new session or a finished compaction moves it
 * on, which makes every earlier observation stale without deleting a row, and what the Agent has
 * lost from its context is shown again. The counter is stored, not held in memory: after a restart
 * it must not count from zero again, or an old row would pass for one made in this context.
 *
 * A row is one `(kind, id)` with the revision shown last (the hash of the text), so a changed
 * description is shown again even within one context.
 */
export class AgentContextLedger {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** The current context's number; 0 until the first advance. */
  generation(): number {
    return Number(readMeta(this.#db, GENERATION_KEY) ?? 0);
  }

  /** Starts a new context: everything shown so far counts as not shown. */
  advance(): number {
    const next = this.generation() + 1;
    writeMeta(this.#db, GENERATION_KEY, String(next));
    return next;
  }

  /**
   * Records `(kind, id, rev)` as shown in the current context. True for the first appearance (the
   * caller shows it), false when this context already showed that revision.
   */
  claim(kind: ContextObservationKind, id: string, rev: string): boolean {
    const result = this.#db
      .prepare(
        `INSERT INTO context_observations (kind, id, rev, generation) VALUES (?, ?, ?, ?)
         ON CONFLICT (kind, id) DO UPDATE SET rev = excluded.rev, generation = excluded.generation
         WHERE rev IS NOT excluded.rev OR generation IS NOT excluded.generation`,
      )
      .run(kind, id, rev, this.generation());
    return result.changes === 1;
  }
}
