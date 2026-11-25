import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { normalizeSeenExactSeqs } from "@lrm/coforge-sdk/internal";
import { AgentStateDb } from "./agent-state-db";
import { escapePathIdentity, isSafePathScope } from "./path-scope";

/** One Agent's consumed cursor for one target: `seq` is the frontier the Agent has consumed
 * (monotonic, never lower), `readOrder` when the target was last reviewed, ordered against every
 * other target's, and `reviewedSeq` the newest message a review showed. `seq` and `reviewedSeq`
 * move apart: a paged read reviews the target without moving the frontier a hold is decided
 * from; a sent send's advanced boundary moves the frontier without reviewing anything; only a
 * presented hold does both. */
export type AgentConsumedSeqEntry = Readonly<{
  seq?: number;
  readOrder?: number;
  reviewedSeq?: number;
  /** `exactSeqs`: messages above `seq` the Agent was shown one by one (a `check`, an anchored
   * `read`, a read the server did not call contiguous), ascending, at most
   * `SEEN_EXACT_SEQS_LIMIT`. A send reports them as `seenExactSeqs` so its freshness check does
   * not count them as unreviewed. */
  exactSeqs?: readonly number[];
  /** The conversation the cursor's sequences count in. A channel recreated under the same name is
   * another conversation whose sequences restart, so a delivery from a different conversation
   * starts the target over. An entry without one is dropped on read: it cannot say whose
   * sequences it holds. */
  conversationId?: string;
}>;

/** The `consumed_seqs`/`consumed_seq_aliases` row set as one state: a `targets` map, the
 * `aliases` map, and the next `readOrder` to hand out. `nextReadOrder` is never stored — `read`
 * recomputes it from the orders the rows actually carry. */
export type AgentConsumedSeqState = Readonly<{
  targets: Readonly<Record<string, AgentConsumedSeqEntry>>;
  /** `aliases`: another spelling of a target mapped to the spelling its cursor is kept under, so
   * both share one consumed state. Chains are compressed on read: every value is a canonical
   * target. */
  aliases: Readonly<Record<string, string>>;
  nextReadOrder: number;
}>;

export type AgentConsumedSeqDelta = Readonly<{
  upsertTargets?: readonly Readonly<{
    target: string;
    entry: AgentConsumedSeqEntry;
  }>[];
  deleteTargets?: readonly string[];
  upsertAliases?: readonly Readonly<{
    spelling: string;
    canonical: string;
  }>[];
  deleteAliases?: readonly string[];
}>;

export type AgentConsumedSeqPort = Readonly<{
  read(agentId: string): AgentConsumedSeqState;
  write(agentId: string, state: AgentConsumedSeqState): void;
  apply?(agentId: string, delta: AgentConsumedSeqDelta): void;
}>;

const SELECT_TARGETS_SQL = `SELECT target, conversation_id, seq, read_order, reviewed_seq, exact_seqs
  FROM consumed_seqs`;

const SELECT_ALIASES_SQL = `SELECT spelling, canonical FROM consumed_seq_aliases`;

const UPSERT_TARGET_SQL = `INSERT INTO consumed_seqs (target, conversation_id, seq, read_order, reviewed_seq, exact_seqs)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(target) DO UPDATE SET
    conversation_id = excluded.conversation_id,
    seq = CASE
      WHEN excluded.conversation_id <> consumed_seqs.conversation_id THEN excluded.seq
      WHEN excluded.seq IS NULL THEN consumed_seqs.seq
      WHEN consumed_seqs.seq IS NULL OR excluded.seq > consumed_seqs.seq THEN excluded.seq
      ELSE consumed_seqs.seq
    END,
    read_order = CASE
      WHEN excluded.conversation_id <> consumed_seqs.conversation_id THEN excluded.read_order
      WHEN excluded.read_order IS NULL THEN consumed_seqs.read_order
      WHEN consumed_seqs.read_order IS NULL OR excluded.read_order > consumed_seqs.read_order
        THEN excluded.read_order
      ELSE consumed_seqs.read_order
    END,
    reviewed_seq = CASE
      WHEN excluded.conversation_id <> consumed_seqs.conversation_id THEN excluded.reviewed_seq
      WHEN excluded.reviewed_seq IS NULL THEN consumed_seqs.reviewed_seq
      WHEN consumed_seqs.reviewed_seq IS NULL
        OR excluded.reviewed_seq > consumed_seqs.reviewed_seq THEN excluded.reviewed_seq
      ELSE consumed_seqs.reviewed_seq
    END,
    exact_seqs = CASE
      WHEN excluded.conversation_id <> consumed_seqs.conversation_id THEN excluded.exact_seqs
      WHEN excluded.seq IS NOT NULL
        AND (consumed_seqs.seq IS NULL OR excluded.seq > consumed_seqs.seq)
        THEN excluded.exact_seqs
      WHEN excluded.seq IS NULL OR consumed_seqs.seq IS NULL OR excluded.seq = consumed_seqs.seq
        THEN CASE
          WHEN excluded.exact_seqs = '[]' OR consumed_seqs.exact_seqs = excluded.exact_seqs
            THEN consumed_seqs.exact_seqs
          WHEN consumed_seqs.exact_seqs = '[]'
            THEN excluded.exact_seqs
          ELSE (
            SELECT json_group_array(value) FROM (
              SELECT value FROM json_each(consumed_seqs.exact_seqs)
              UNION
              SELECT value FROM json_each(excluded.exact_seqs)
            )
          )
        END
      ELSE consumed_seqs.exact_seqs
    END
  WHERE
    excluded.conversation_id <> consumed_seqs.conversation_id
    OR (excluded.seq IS NOT NULL AND (consumed_seqs.seq IS NULL OR excluded.seq > consumed_seqs.seq))
    OR (excluded.read_order IS NOT NULL AND (consumed_seqs.read_order IS NULL OR excluded.read_order > consumed_seqs.read_order))
    OR (excluded.reviewed_seq IS NOT NULL AND (consumed_seqs.reviewed_seq IS NULL OR excluded.reviewed_seq > consumed_seqs.reviewed_seq))
    OR (
      excluded.exact_seqs <> '[]'
      AND excluded.exact_seqs <> consumed_seqs.exact_seqs
      AND (excluded.seq IS NULL OR consumed_seqs.seq IS NULL OR excluded.seq >= consumed_seqs.seq)
    )`;

const UPSERT_ALIAS_SQL = `INSERT INTO consumed_seq_aliases (spelling, canonical) VALUES (?, ?)
  ON CONFLICT(spelling) DO UPDATE SET canonical = excluded.canonical
  WHERE consumed_seq_aliases.canonical <> excluded.canonical`;

const DELETE_TARGET_SQL = `DELETE FROM consumed_seqs WHERE target = ?`;
const DELETE_ALIAS_SQL = `DELETE FROM consumed_seq_aliases WHERE spelling = ?`;
const COUNT_TARGETS_SQL = `SELECT COUNT(*) AS count FROM consumed_seqs`;
const COUNT_ALIASES_SQL = `SELECT COUNT(*) AS count FROM consumed_seq_aliases`;
const DELETE_ALL_TARGETS_SQL = `DELETE FROM consumed_seqs`;
const DELETE_ALL_ALIASES_SQL = `DELETE FROM consumed_seq_aliases`;
const DELETE_UNLISTED_TARGETS_SQL = `DELETE FROM consumed_seqs WHERE target NOT IN (SELECT value FROM json_each(?))`;
const DELETE_UNLISTED_ALIASES_SQL = `DELETE FROM consumed_seq_aliases WHERE spelling NOT IN (SELECT value FROM json_each(?))`;

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

type ConsumedSeqRow = {
  target: string;
  conversation_id: string;
  seq: number | null;
  read_order: number | null;
  reviewed_seq: number | null;
  exact_seqs: string;
};

type PersistableTargetRow = {
  target: string;
  entry: AgentConsumedSeqEntry;
  conversationId: string;
};

export class AgentConsumedSeqStore implements AgentConsumedSeqPort {
  readonly #root: string;
  readonly #dbs = new Map<string, AgentStateDb>();
  #closed = false;

  constructor(rootDirectory: string) {
    if (!rootDirectory) throw new Error("consumed-sequence state directory is required");
    this.#root = rootDirectory;
  }

  stateDb(agentId: string): AgentStateDb {
    const existing = this.#dbs.get(agentId);
    if (existing) return existing;
    const db = AgentStateDb.open(this.#root, agentId);
    this.#dbs.set(agentId, db);
    return db;
  }

  borrowStateDb(agentId: string): AgentStateDb | undefined {
    if (this.#closed) return undefined;
    return this.stateDb(agentId);
  }

  read(agentId: string): AgentConsumedSeqState {
    if (!isSafePathScope(agentId)) throw new Error("invalid consumed-sequence Agent scope");
    let rows: ConsumedSeqRow[];
    let aliasRows: { spelling: string; canonical: string }[];
    try {
      const db = this.stateDb(agentId).database;
      rows = db.query(SELECT_TARGETS_SQL).all() as ConsumedSeqRow[];
      aliasRows = db.query(SELECT_ALIASES_SQL).all() as {
        spelling: string;
        canonical: string;
      }[];
    } catch {
      return { targets: {}, aliases: {}, nextReadOrder: 1 };
    }
    return shapeState(rows, aliasRows);
  }

  apply(agentId: string, delta: AgentConsumedSeqDelta): void {
    if (!isSafePathScope(agentId)) throw new Error("invalid consumed-sequence Agent scope");
    const targets: PersistableTargetRow[] = [];
    if (delta.upsertTargets) {
      for (const { target, entry } of delta.upsertTargets) {
        if (entry.conversationId) {
          targets.push({ target, entry, conversationId: entry.conversationId });
        }
      }
    }
    const deleteTargets = delta.deleteTargets ?? [];
    const upsertAliases = delta.upsertAliases ?? [];
    const deleteAliases = delta.deleteAliases ?? [];
    const opCount =
      targets.length + deleteTargets.length + upsertAliases.length + deleteAliases.length;
    if (opCount === 0) return;

    const db = this.stateDb(agentId).database;
    const runOps = () => {
      if (targets.length > 0) {
        const upsert = db.query(UPSERT_TARGET_SQL);
        for (const { target, entry, conversationId } of targets) {
          upsert.run(
            target,
            conversationId,
            entry.seq ?? null,
            entry.readOrder ?? null,
            entry.reviewedSeq ?? null,
            entry.exactSeqs?.length ? JSON.stringify(entry.exactSeqs) : "[]",
          );
        }
      }
      if (deleteTargets.length > 0) {
        const removeTarget = db.query(DELETE_TARGET_SQL);
        for (const target of deleteTargets) removeTarget.run(target);
      }
      if (upsertAliases.length > 0) {
        const upsertAlias = db.query(UPSERT_ALIAS_SQL);
        for (const { spelling, canonical } of upsertAliases) upsertAlias.run(spelling, canonical);
      }
      if (deleteAliases.length > 0) {
        const removeAlias = db.query(DELETE_ALIAS_SQL);
        for (const spelling of deleteAliases) removeAlias.run(spelling);
      }
    };

    if (opCount === 1) {
      runOps();
      return;
    }
    db.transaction(runOps)();
  }

  write(agentId: string, state: AgentConsumedSeqState): void {
    const db = this.stateDb(agentId).database;
    const upsert = db.query(UPSERT_TARGET_SQL);
    const alias = db.query(UPSERT_ALIAS_SQL);
    const rows: PersistableTargetRow[] = [];
    for (const [target, entry] of Object.entries(state.targets)) {
      if (entry.conversationId) {
        rows.push({ target, entry, conversationId: entry.conversationId });
      }
    }
    const spellings = Object.keys(state.aliases);
    db.transaction(() => {
      for (const { target, entry, conversationId } of rows) {
        upsert.run(
          target,
          conversationId,
          entry.seq ?? null,
          entry.readOrder ?? null,
          entry.reviewedSeq ?? null,
          entry.exactSeqs?.length ? JSON.stringify(entry.exactSeqs) : "[]",
        );
      }
      for (const spelling of spellings) alias.run(spelling, state.aliases[spelling] ?? "");
      deleteUnlistedTargets(db, rows);
      deleteUnlistedAliases(db, spellings);
    })();
  }

  remove(agentId: string): void {
    if (!isSafePathScope(agentId)) throw new Error("invalid consumed-sequence Agent scope");
    this.#dbs.get(agentId)?.close();
    this.#dbs.delete(agentId);
    rmSync(join(this.#root, "agent-state", escapePathIdentity(agentId)), {
      recursive: true,
      force: true,
    });
  }

  close(): void {
    this.#closed = true;
    for (const db of this.#dbs.values()) db.close();
    this.#dbs.clear();
  }
}

function shapeState(
  rows: ConsumedSeqRow[],
  aliasRows: { spelling: string; canonical: string }[],
): AgentConsumedSeqState {
  const targets: Record<string, AgentConsumedSeqEntry> = {};
  let maxObservedOrder = 0;
  for (const row of rows) {
    if (!row.target || typeof row.conversation_id !== "string" || !row.conversation_id) continue;
    const seq = positiveFiniteNumber(row.seq ?? undefined);
    const readOrder = positiveFiniteNumber(row.read_order ?? undefined);
    let exactSeqs: readonly number[] = [];
    try {
      exactSeqs = normalizeSeenExactSeqs(JSON.parse(row.exact_seqs || "[]"), seq ?? 0);
    } catch {
      exactSeqs = [];
    }
    if (seq === undefined && readOrder === undefined && exactSeqs.length === 0) continue;
    const reviewedSeq =
      readOrder === undefined ? undefined : positiveFiniteNumber(row.reviewed_seq ?? undefined);
    targets[row.target] = {
      ...(seq !== undefined ? { seq } : {}),
      ...(readOrder !== undefined ? { readOrder } : {}),
      ...(reviewedSeq !== undefined ? { reviewedSeq } : {}),
      ...(exactSeqs.length > 0 ? { exactSeqs } : {}),
      conversationId: row.conversation_id,
    };
    maxObservedOrder = Math.max(maxObservedOrder, readOrder ?? 0);
  }
  const links = new Map<string, string>();
  for (const { spelling, canonical } of aliasRows)
    if (spelling.length > 0 && canonical.length > 0 && spelling !== canonical)
      links.set(spelling, canonical);
  const aliases: Record<string, string> = {};
  for (const spelling of links.keys()) {
    let canonical = spelling;
    const visited = new Set<string>([spelling]);
    for (let next = links.get(canonical); next !== undefined; next = links.get(canonical)) {
      if (visited.has(next)) {
        canonical = spelling;
        break;
      }
      visited.add(next);
      canonical = next;
    }
    if (canonical !== spelling) aliases[spelling] = canonical;
  }
  return { targets, aliases, nextReadOrder: maxObservedOrder + 1 };
}

function deleteUnlistedTargets(db: Database, rows: readonly PersistableTargetRow[]): void {
  const existing = (db.query(COUNT_TARGETS_SQL).get() as { count: number }).count;
  if (existing <= rows.length) return;
  if (rows.length === 0) db.query(DELETE_ALL_TARGETS_SQL).run();
  else db.query(DELETE_UNLISTED_TARGETS_SQL).run(JSON.stringify(rows.map((row) => row.target)));
}

function deleteUnlistedAliases(db: Database, spellings: readonly string[]): void {
  const existing = (db.query(COUNT_ALIASES_SQL).get() as { count: number }).count;
  if (existing <= spellings.length) return;
  if (spellings.length === 0) db.query(DELETE_ALL_ALIASES_SQL).run();
  else db.query(DELETE_UNLISTED_ALIASES_SQL).run(JSON.stringify(spellings));
}
