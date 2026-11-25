import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AGENT_COMMAND_GUIDANCE, type AgentCommandGuidanceResponse } from "@lrm/coforge-sdk/agent";
import { AgentStateDb, readMeta, writeMeta } from "./agent-state-db";
import { escapePathIdentity } from "./path-scope";

export type ContextObservationKind = "sender" | "channel" | "guidance";
export type ContextObservationEntry = readonly [ContextObservationKind, string, string];

const GENERATION_KEY = "contextGeneration";
const CLAIM_SQL = `INSERT INTO context_observations (kind, id, rev, generation) VALUES (?, ?, ?, ?)
  ON CONFLICT (kind, id) DO UPDATE SET rev = excluded.rev, generation = excluded.generation
  WHERE rev IS NOT excluded.rev OR generation IS NOT excluded.generation`;
const RELEASE_SQL = `DELETE FROM context_observations
  WHERE kind = ? AND id = ? AND rev = ? AND generation = ?`;

export class AgentContextLedger {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  generation(): number {
    return Number(readMeta(this.#db, GENERATION_KEY) ?? 0);
  }

  advance(): number {
    const next = this.generation() + 1;
    writeMeta(this.#db, GENERATION_KEY, String(next));
    return next;
  }

  claim(kind: ContextObservationKind, id: string, text: string): boolean {
    const rev = revisionOf(text);
    const result = this.#db.query(CLAIM_SQL).run(kind, id, rev, this.generation());
    return result.changes === 1;
  }

  claimBatch(entries: readonly ContextObservationEntry[]): boolean[] {
    if (entries.length === 0) return [];
    const statement = this.#db.query(CLAIM_SQL);
    return this.#db.transaction(() => {
      const generation = this.generation();
      return entries.map(
        ([kind, id, text]) => statement.run(kind, id, revisionOf(text), generation).changes === 1,
      );
    })();
  }

  release(kind: ContextObservationKind, id: string, text: string): void {
    this.#db.query(RELEASE_SQL).run(kind, id, revisionOf(text), this.generation());
  }

  releaseBatch(entries: readonly ContextObservationEntry[]): void {
    if (entries.length === 0) return;
    const statement = this.#db.query(RELEASE_SQL);
    this.#db.transaction(() => {
      const generation = this.generation();
      for (let i = 0; i < entries.length; i++) {
        const [kind, id, text] = entries[i]!;
        statement.run(kind, id, revisionOf(text), generation);
      }
    })();
  }
}

const revisionOf = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("base64url");

/**
 * Evaluates or pre-satisfies (`--help`) progressive CLI command guidance for `agentId`.
 * When the Agent's runtime reports compaction, claims `"guidance"` once per `contextGeneration`
 * in `state.db`; otherwise returns an inline hint without SQLite elision.
 */
export function evaluateAgentCommandGuidance(input: {
  stateDirectory: string;
  hasExplicitStateDir?: boolean;
  stateDb?: AgentStateDb | (() => AgentStateDb | undefined);
  agentId: string;
  operation: "check" | "satisfy";
  command: string;
  reportsCompaction?: (agentId: string) => boolean;
}): AgentCommandGuidanceResponse {
  const text = AGENT_COMMAND_GUIDANCE[input.command];
  if (!text) return { ok: true, guidance: null };
  if (input.reportsCompaction?.(input.agentId) !== true) {
    return input.operation === "satisfy"
      ? { ok: true, guidance: null }
      : { ok: true, guidance: text, mode: "inline" };
  }
  const borrowed = typeof input.stateDb === "function" ? input.stateDb() : input.stateDb;
  if (borrowed) {
    const claimed = new AgentContextLedger(borrowed.database).claim(
      "guidance",
      input.command,
      text,
    );
    if (input.operation === "satisfy") return { ok: true, guidance: null };
    return {
      ok: true,
      guidance: claimed ? text : null,
      mode: "once_per_context",
    };
  }
  const hasStateDb =
    Boolean(input.hasExplicitStateDir) ||
    existsSync(
      join(input.stateDirectory, "agent-state", escapePathIdentity(input.agentId), "state.db"),
    );
  if (!hasStateDb) {
    return input.operation === "satisfy"
      ? { ok: true, guidance: null }
      : { ok: true, guidance: text, mode: "inline" };
  }
  const stateDb = AgentStateDb.open(input.stateDirectory, input.agentId);
  try {
    const ledger = new AgentContextLedger(stateDb.database);
    const claimed = ledger.claim("guidance", input.command, text);
    if (input.operation === "satisfy") return { ok: true, guidance: null };
    return {
      ok: true,
      guidance: claimed ? text : null,
      mode: "once_per_context",
    };
  } finally {
    stateDb.close();
  }
}
