import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getLogger } from "@logtape/logtape";
import type {
  ImportantUnreadNotice,
  UnreadNoticeConversation,
} from "../daemon-runtime/important-unread-notice";
import { escapePathIdentity, isSafePathScope } from "./path-scope";

const logger = getLogger(["coforge", "daemon", "important-unread"]);

/** This OS process's lifetime, so a record written here is not restored by the same process: the
 * live state is the authority, and the record only has to survive a *new* process. */
const PROCESS_OWNER = `${process.pid}:${Date.now()}`;

/** The file one Agent's pending notice lives in, beside its other state. */
function noticePath(stateDirectory: string, agentId: string): string {
  if (!isSafePathScope(agentId)) throw new Error("invalid Agent state scope");
  return join(stateDirectory, "agent-state", escapePathIdentity(agentId), "important-unread.json");
}

/**
 * An Agent's pending "you have important unread messages", kept where a restarted Daemon finds
 * it. The state is what a fresh process re-sends once: a notice written before the restart is not
 * re-sent into the same process (the live state decides that), but a new process cannot know it
 * was written at all. Writes are one small private JSON file per Agent; a corrupt or unreadable
 * file is dropped rather than trusted.
 */
export class ImportantUnreadNoticeStore {
  readonly #preparedDirs = new Set<string>();

  constructor(
    private readonly stateDirectory: () => string | undefined,
    private readonly owner: string = PROCESS_OWNER,
  ) {}

  list(): ImportantUnreadNotice[] {
    const stateDirectory = this.stateDirectory();
    if (!stateDirectory) return [];
    const directory = join(stateDirectory, "agent-state");
    if (!existsSync(directory)) return [];
    const notices: ImportantUnreadNotice[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let agentId: string;
      try {
        agentId = decodeURIComponent(entry.name);
      } catch {
        continue;
      }
      if (!isSafePathScope(agentId)) continue;
      const path = noticePath(stateDirectory, agentId);
      try {
        const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        if (value?.owner === this.owner) continue;
        const notice = readNotice(value, agentId);
        if (notice) notices.push(notice);
        else this.clear(agentId);
      } catch {
        if (existsSync(path)) this.clear(agentId);
      }
    }
    return notices;
  }

  save(notice: ImportantUnreadNotice): void {
    try {
      const stateDirectory = this.stateDirectory();
      if (!stateDirectory) return;
      const path = noticePath(stateDirectory, notice.agentId);
      const dir = dirname(path);
      const body = `${JSON.stringify({ version: 1, owner: this.owner, ...notice })}\n`;
      const temporary = `${path}.tmp`;
      if (!this.#preparedDirs.has(dir)) {
        this.#prepareDir(dir);
      }
      try {
        writeFileSync(temporary, body, { mode: 0o600 });
        renameSync(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.#preparedDirs.delete(dir);
        this.#prepareDir(dir);
        writeFileSync(temporary, body, { mode: 0o600 });
        renameSync(temporary, path);
      }
    } catch (error) {
      logger.warn("Important unread notice could not be recorded", {
        event: "agent.runtime.important_unread_persist_failed",
        agent_id: notice.agentId,
        error_type: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  clear(agentId: string): void {
    const stateDirectory = this.stateDirectory();
    if (!stateDirectory) return;
    const path = noticePath(stateDirectory, agentId);
    this.#preparedDirs.delete(dirname(path));
    try {
      unlinkSync(path);
    } catch {
      return;
    }
  }

  #prepareDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.#preparedDirs.add(dir);
  }
}

/** One stored record, or undefined when it says nothing a restart can act on. */
function readNotice(
  value: Record<string, unknown>,
  agentId: string,
): ImportantUnreadNotice | undefined {
  const highestSequence = value.highestSequence;
  if (typeof highestSequence !== "number" || !Number.isSafeInteger(highestSequence)) return;
  if (highestSequence <= 0) return undefined;
  const key = value.key;
  if (typeof key !== "string" || !key) return undefined;
  const conversations = readConversations(value.conversations);
  if (conversations.length === 0) return undefined;
  const attempts = typeof value.attempts === "number" && value.attempts >= 0 ? value.attempts : 0;
  return {
    agentId,
    key,
    highestSequence,
    conversations,
    attempts,
    ...(value.lastAttempt === "accepted" || value.lastAttempt === "rejected"
      ? { lastAttempt: value.lastAttempt }
      : {}),
    ...(millis(value.writtenAtMs) ? { writtenAtMs: value.writtenAtMs as number } : {}),
    ...(millis(value.nextAttemptAtMs) ? { nextAttemptAtMs: value.nextAttemptAtMs as number } : {}),
  };
}

function readConversations(value: unknown): UnreadNoticeConversation[] {
  if (!Array.isArray(value)) return [];
  const conversations: UnreadNoticeConversation[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.conversationId !== "string" || !record.conversationId) continue;
    if (!Number.isSafeInteger(record.firstSequence)) continue;
    conversations.push({
      conversationId: record.conversationId,
      ...(typeof record.target === "string" && record.target ? { target: record.target } : {}),
      firstSequence: record.firstSequence as number,
      ...(record.independentEvent === true ? { independentEvent: true as const } : {}),
      ...(typeof record.lastSequence === "number" &&
      Number.isSafeInteger(record.lastSequence) &&
      record.lastSequence >= (record.firstSequence as number)
        ? { lastSequence: record.lastSequence }
        : {}),
      count: typeof record.count === "number" && record.count > 0 ? record.count : 1,
    });
  }
  return conversations;
}

function millis(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}
