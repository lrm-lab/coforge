import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { chmodSync, lstatSync, mkdirSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { thrownMessage } from "@lrm/coforge-sdk/internal";
import { escapePathIdentity, isSafePathScope } from "./path-scope";

const logger = getLogger(["coforge", "daemon", "agent-state-db"]);

/**
 * The durable per-Agent ledger (`agent-state/<agentId>/state.db`, modeled on Raft's): one row per
 * conversation for the consumed cursor and for a held send's draft. WAL + `synchronous=NORMAL`
 * trades a checkpoint's worth of durability for single-statement commits fast enough that no
 * batching or stop-time flush exists — every write commits when it happens.
 *
 * The database lives in CoForge's own state directory, not `/tmp`: the cursor decides held sends
 * and the draft re-arms a stopped Agent's pending notice, so both are daemon state, not CLI
 * scratch. The first open imports the legacy JSON files (which did live under `/tmp`) in one
 * transaction and removes them once the commit lands.
 */
export class AgentStateDb {
  readonly #db: Database;

  private constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Opens (or creates) one Agent's state database. The Agent id is the same path scope every
   * store in this directory applies.
   */
  static open(stateDirectory: string, agentId: string): AgentStateDb {
    if (!stateDirectory) throw new Error("Agent state directory is required");
    if (!isSafePathScope(agentId)) throw new Error("invalid Agent state scope");
    const directory = join(stateDirectory, "agent-state", escapePathIdentity(agentId));
    prepareDirectory(join(stateDirectory, "agent-state"));
    prepareDirectory(directory);
    const db = new Database(join(directory, "state.db"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS consumed_seqs (
        target TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        seq INTEGER,
        read_order INTEGER,
        reviewed_seq INTEGER,
        exact_seqs TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS consumed_seq_aliases (
        spelling TEXT PRIMARY KEY,
        canonical TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS drafts (
        target TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        attachment_ids TEXT,
        idempotency_key TEXT NOT NULL,
        mentions TEXT,
        saved_at INTEGER NOT NULL,
        rehold_count INTEGER NOT NULL DEFAULT 0,
        seen_up_to_seq INTEGER,
        seen_exact_seqs TEXT
      );
    `);
    const handle = new AgentStateDb(db);
    handle.#importLegacyJson(agentId);
    return handle;
  }

  /** The underlying connection: the cursor and draft stores share one so a write is one commit. */
  get database(): Database {
    return this.#db;
  }

  close(): void {
    this.#db.close();
  }

  /**
   * First-boot import: both legacy JSON files move into this database in one transaction and are
   * deleted once the commit succeeds. A crash mid-import simply re-runs on the next open; absent
   * files are skipped, and a file that cannot parse leaves the store that read it starting empty,
   * exactly as the JSON readers behaved.
   */
  #importLegacyJson(agentId: string): void {
    const legacy = legacyPaths(agentId);
    const consumed = readLegacyJson(legacy.consumedSeqs);
    const draft = readLegacyJson(legacy.drafts);
    if (consumed === undefined && draft === undefined) return;
    try {
      this.#db.transaction(() => {
        if (consumed) importConsumedSeqs(this.#db, consumed);
        if (draft) importDrafts(this.#db, draft);
      })();
    } catch (error) {
      logger.warn("could not import the legacy Agent state files", {
        event: "agent_state.migration_failed",
        agent_id: agentId,
        error: thrownMessage(error),
      });
      return;
    }
    // Only a file whose content was actually imported goes away: a corrupt one stays for recovery,
    // exactly as the JSON readers left it.
    if (consumed !== undefined) rmSync(legacy.consumedSeqs, { force: true });
    if (draft !== undefined) rmSync(legacy.drafts, { force: true });
    for (const parent of [dirname(legacy.consumedSeqs), dirname(legacy.drafts)])
      rmdirSyncQuiet(parent);
  }
}

/**
 * Where the JSON stores kept one Agent's state: the consumed cursor and the draft each had their
 * own environment override and fell back to `/tmp`, so the migration honors both overrides.
 */
function legacyPaths(agentId: string): { consumedSeqs: string; drafts: string } {
  const euid = escapePathIdentity(String(process.geteuid?.() ?? userInfo().username));
  const scoped = escapePathIdentity(agentId);
  return {
    consumedSeqs: join(
      Bun.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR ?? tmpdir(),
      `coforge-cli-consumed-seq-${euid}`,
      scoped,
      "consumed-seqs.json",
    ),
    drafts: join(
      Bun.env.COFORGE_CLI_DRAFT_STATE_DIR ?? tmpdir(),
      `coforge-cli-attested-send-${euid}`,
      scoped,
      "continue-state.json",
    ),
  };
}

function rmdirSyncQuiet(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // Not empty, or already gone: the files are what mattered.
  }
}

function readLegacyJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The legacy `consumed-seqs.json` shape: `targets`, `aliases` and a `nextReadOrder` the DB
 * recomputes from `read_order` and never imports. */
function importConsumedSeqs(db: Database, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const raw = value as { targets?: unknown; aliases?: unknown };
  const insert = db.prepare(
    `INSERT OR IGNORE INTO consumed_seqs
       (target, conversation_id, seq, read_order, reviewed_seq, exact_seqs)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  if (raw.targets && typeof raw.targets === "object" && !Array.isArray(raw.targets))
    for (const [target, entry] of Object.entries(raw.targets as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.conversationId !== "string" || !record.conversationId) continue;
      insert.run(
        target,
        record.conversationId,
        toInteger(record.seq),
        toInteger(record.readOrder),
        toInteger(record.reviewedSeq),
        JSON.stringify(Array.isArray(record.exactSeqs) ? record.exactSeqs : []),
      );
    }
  const alias = db.prepare(
    `INSERT OR IGNORE INTO consumed_seq_aliases (spelling, canonical) VALUES (?, ?)`,
  );
  if (raw.aliases && typeof raw.aliases === "object" && !Array.isArray(raw.aliases))
    for (const [spelling, canonical] of Object.entries(raw.aliases as Record<string, unknown>))
      if (spelling && typeof canonical === "string" && canonical && spelling !== canonical)
        alias.run(spelling, canonical);
}

/** The legacy `continue-state.json` shape: a `targets` map of held drafts. */
function importDrafts(db: Database, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const raw = value as { targets?: unknown };
  if (!raw.targets || typeof raw.targets !== "object" || Array.isArray(raw.targets)) return;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO drafts
       (target, content, attachment_ids, idempotency_key, mentions, saved_at, rehold_count,
        seen_up_to_seq, seen_exact_seqs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [target, entry] of Object.entries(raw.targets as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.idempotencyKey !== "string" || !record.idempotencyKey) continue;
    insert.run(
      target,
      String(record.content ?? ""),
      jsonText(record.attachmentIds),
      record.idempotencyKey,
      jsonText(record.mentions),
      toInteger(record.savedAt) ?? 0,
      toInteger(record.reholdCount) ?? 0,
      toInteger(record.seenUpToSeq),
      jsonText(record.seenExactSeqs),
    );
  }
}

function toInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function jsonText(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/** The same directory hardening the JSON stores applied: real directories (no symlinks) owned by
 * this user, mode `0700`. The check comes before `mkdir` — a linked path would make it throw an
 * OS error that hides which rule the path actually broke. */
function prepareDirectory(path: string): void {
  try {
    lstatSync(path);
  } catch {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isDirectory())
    throw new Error("Agent state path must be a real directory");
  const uid = process.geteuid?.();
  if (uid !== undefined && status.uid !== uid)
    throw new Error("Agent state directory must be owned by the current user");
  chmodSync(path, 0o700);
}
