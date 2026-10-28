import { normalizeSeenExactSeqs } from "@lrm/coforge-sdk/internal";
import { AgentStateDb } from "./agent-state-db";
import { isSafePathScope } from "./path-scope";

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

/**
 * The port the attention index persists through. The index holds the Agent's consumed state in
 * memory once it has read it, so a store only reads a snapshot and writes one: one write per
 * operation, however many targets, frontiers, exact sequences, aliases and read orders that
 * operation touched.
 */
export type AgentConsumedSeqPort = Readonly<{
  /** Never throws, and an empty or unreadable table is an empty state. */
  read(agentId: string): AgentConsumedSeqState;
  /** Replaces the Agent's durable state with this snapshot, in one transaction. */
  write(agentId: string, state: AgentConsumedSeqState): void;
}>;

/** A number that can be a sequence or a read order: positive and finite, or nothing. */
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

/**
 * The daemon's durable copy of the consumed cursor, one row per target in the Agent's
 * `state.db` (`agent-state/<agentId>/`, in the daemon state directory — see `AgentStateDb` for
 * why it is not `/tmp` and why there is no write delay or flush).
 *
 * Why it has to be durable: the cursor decides whether a send is held (`modelSeenSequence`), which
 * frontier and exact sequences travel with a send, and whether a top-level send under a parent
 * whose newest read context is a thread needs confirming (and which threads a review showed
 * anything in).
 *
 * The daemon is the table's only writer and keeps the state in memory once read, so it writes a
 * whole snapshot rather than reading, modifying and writing per record: `write` replaces every
 * row in one transaction.
 */
export class AgentConsumedSeqStore implements AgentConsumedSeqPort {
  readonly #root: string;
  readonly #dbs = new Map<string, AgentStateDb>();

  /** The daemon's state directory — `agent-state/<agentId>/state.db` lives under it. */
  constructor(rootDirectory: string) {
    if (!rootDirectory) throw new Error("consumed-sequence state directory is required");
    this.#root = rootDirectory;
  }

  /** The Agent's shared ledger: the draft store writes the same database. */
  stateDb(agentId: string): AgentStateDb {
    const existing = this.#dbs.get(agentId);
    if (existing) return existing;
    const db = AgentStateDb.open(this.#root, agentId);
    this.#dbs.set(agentId, db);
    return db;
  }

  read(agentId: string): AgentConsumedSeqState {
    // The scope check happens before the read is guarded: an id that could not be a path segment is
    // a caller error, and swallowing it would answer "empty cursor" to a typo.
    if (!isSafePathScope(agentId)) throw new Error("invalid consumed-sequence Agent scope");
    let rows: ConsumedSeqRow[];
    let aliasRows: { spelling: string; canonical: string }[];
    try {
      const db = this.stateDb(agentId).database;
      rows = db
        .prepare(
          `SELECT target, conversation_id, seq, read_order, reviewed_seq, exact_seqs
           FROM consumed_seqs`,
        )
        .all() as ConsumedSeqRow[];
      aliasRows = db.prepare(`SELECT spelling, canonical FROM consumed_seq_aliases`).all() as {
        spelling: string;
        canonical: string;
      }[];
    } catch {
      // A database that cannot be opened or read starts the Agent over from an empty state rather
      // than failing the read that needs the cursor.
      return { targets: {}, aliases: {}, nextReadOrder: 1 };
    }
    return shapeState(rows, aliasRows);
  }

  write(agentId: string, state: AgentConsumedSeqState): void {
    const db = this.stateDb(agentId).database;
    const insert = db.prepare(
      `INSERT INTO consumed_seqs (target, conversation_id, seq, read_order, reviewed_seq, exact_seqs)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const alias = db.prepare(
      `INSERT INTO consumed_seq_aliases (spelling, canonical) VALUES (?, ?)`,
    );
    db.transaction(() => {
      db.exec("DELETE FROM consumed_seqs");
      db.exec("DELETE FROM consumed_seq_aliases");
      for (const [target, entry] of Object.entries(state.targets)) {
        if (!entry.conversationId) continue;
        insert.run(
          target,
          entry.conversationId,
          entry.seq ?? null,
          entry.readOrder ?? null,
          entry.reviewedSeq ?? null,
          JSON.stringify(entry.exactSeqs ?? []),
        );
      }
      for (const [spelling, canonical] of Object.entries(state.aliases))
        alias.run(spelling, canonical);
    })();
  }

  close(): void {
    for (const db of this.#dbs.values()) db.close();
    this.#dbs.clear();
  }
}

/**
 * Keeps the rows that carry an order, a sequence or exact sequences above that sequence,
 * compresses alias chains, and starts from a `nextReadOrder` that is above every order in the
 * table — so a row written by an older build (or hand-edited) can never hand out an order it
 * already used. A `reviewedSeq` is kept only beside a `readOrder`, since it describes a review.
 */
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
    // A shown message without a review order is not a review; drop it with the order.
    const reviewedSeq =
      readOrder === undefined ? undefined : positiveFiniteNumber(row.reviewed_seq ?? undefined);
    targets[row.target] = {
      ...(seq !== undefined ? { seq } : {}),
      ...(readOrder !== undefined ? { readOrder } : {}),
      ...(reviewedSeq !== undefined ? { reviewedSeq } : {}),
      ...(exactSeqs.length > 0 ? { exactSeqs } : {}),
      conversationId: row.conversation_id,
    };
    // Only a real order counts. There is no fallback to `seq`, and a frontier recorded without a
    // review must not push the order counter up to its sequence.
    maxObservedOrder = Math.max(maxObservedOrder, readOrder ?? 0);
  }
  const links = new Map<string, string>();
  for (const { spelling, canonical } of aliasRows)
    if (spelling.length > 0 && canonical.length > 0 && spelling !== canonical)
      links.set(spelling, canonical);
  // A chain is walked once here rather than on every lookup, so each spelling maps straight to
  // its canonical target. A cycle names no canonical target and is dropped.
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
