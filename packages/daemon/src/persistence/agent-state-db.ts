import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { chmodSync, lstatSync, mkdirSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { thrownMessage } from "@lrm/coforge-sdk/internal";
import { escapePathIdentity, isSafePathScope } from "./path-scope";

const logger = getLogger(["coforge", "daemon", "agent-state-db"]);

/** The schema this build writes. A database that reports a higher one is refused, not migrated. */
const SCHEMA_VERSION = 1;

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
    // A database a newer build wrote may carry a shape this one cannot read: refuse before any
    // schema statement touches it.
    const metaExists = Boolean(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).get(),
    );
    const found = metaExists
      ? (db.prepare(`SELECT value FROM meta WHERE key = 'version'`).get() as {
          value: string;
        } | null)
      : null;
    const version = found ? Number(found.value) : undefined;
    if (version !== undefined && Number.isSafeInteger(version) && version > SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `Agent state database version ${version} is newer than this daemon (${SCHEMA_VERSION})`,
      );
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
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
    if (version === undefined) writeMeta(db, "version", String(SCHEMA_VERSION));
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
   * The one-time import of the JSON stores this database replaces. `meta.legacyImported` records
   * that it ran, so a later open never re-reads the files; a corrupt file leaves the marker unset
   * and itself in place, so a repair can still be imported. A crash mid-import simply re-runs on
   * the next open: absent files are skipped, and a file that cannot parse leaves the store that
   * read it starting empty, exactly as the JSON readers behaved.
   */
  #importLegacyJson(agentId: string): void {
    if (readMeta(this.#db, "legacyImported") === "true") return;
    const legacy = legacyPaths(agentId);
    const consumed = readLegacyJson(legacy.consumedSeqs, agentId);
    const draft = readLegacyJson(legacy.drafts, agentId);
    if (!consumed.present && !draft.present) {
      writeMeta(this.#db, "legacyImported", "true");
      return;
    }
    try {
      this.#db.transaction(() => {
        if (consumed.value !== undefined) importConsumedSeqs(this.#db, consumed.value);
        if (draft.value !== undefined) importDrafts(this.#db, draft.value);
      })();
    } catch (error) {
      logger.warn("could not import the legacy Agent state files", {
        event: "agent_state.migration_failed",
        agent_id: agentId,
        error: thrownMessage(error),
      });
      return;
    }
    // Only a file whose content was actually imported goes away: a corrupt one stays for recovery.
    if (consumed.value !== undefined) rmSync(legacy.consumedSeqs, { force: true });
    if (draft.value !== undefined) rmSync(legacy.drafts, { force: true });
    for (const parent of [dirname(legacy.consumedSeqs), dirname(legacy.drafts)])
      rmdirSyncQuiet(parent);
    // A corrupt file still present means the import is not finished; retry on a later open.
    if (!existsSync(legacy.consumedSeqs) && !existsSync(legacy.drafts))
      writeMeta(this.#db, "legacyImported", "true");
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

/**
 * `present` says the file exists; `value` is its parsed content, or `undefined` when it cannot
 * parse — the difference decides whether the file is removed or left for recovery.
 *
 * The legacy root is the OS temp directory, which every local user can write. The JSON stores
 * refused a linked or foreign directory before writing; the import applies the same rules before
 * reading, or another user could plant a `continue-state.json` (or a symlink to one) and have its
 * content become this Agent's pending send.
 */
function readLegacyJson(path: string, agentId: string): { present: boolean; value: unknown } {
  if (!existsSync(path)) return { present: false, value: undefined };
  const refusal = unsafeLegacyPath(path);
  if (refusal !== undefined) {
    logger.warn("skipping a legacy Agent state file that is not ours", {
      event: "agent_state.migration_refused",
      agent_id: agentId,
      reason: refusal,
    });
    // Left in place and left unimported: the marker stays unset, so a repaired file can still
    // be imported later.
    return { present: true, value: undefined };
  }
  try {
    return { present: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { present: true, value: undefined };
  }
}

/** The first rule `path` breaks against the legacy stores' own path policy, or `undefined`. */
function unsafeLegacyPath(path: string): string | undefined {
  const uid = process.geteuid?.();
  // Check only directories created by the legacy store. The OS temp directory itself is outside
  // our ownership boundary (and is root-owned on Linux), so including it rejects every import.
  const levels = [dirname(dirname(path)), dirname(path)];
  for (const level of levels) {
    let status;
    try {
      status = lstatSync(level);
    } catch {
      return "missing-directory";
    }
    if (status.isSymbolicLink() || !status.isDirectory()) return "not-a-directory";
    if (uid !== undefined && status.uid !== uid) return "foreign-directory";
  }
  let file;
  try {
    file = lstatSync(path);
  } catch {
    return "missing-file";
  }
  if (file.isSymbolicLink() || !file.isFile()) return "not-a-file";
  if (uid !== undefined && file.uid !== uid) return "foreign-file";
  return undefined;
}

function readMeta(db: Database, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as {
    value: string;
  } | null;
  return row?.value;
}

function writeMeta(db: Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
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
