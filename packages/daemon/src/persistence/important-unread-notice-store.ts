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
  /** A thunk: the runtime's state directory is assigned after its field initializers run. The
   * owner defaults to this process and is injectable for tests that stand in for a restart. */
  constructor(
    private readonly stateDirectory: () => string | undefined,
    private readonly owner: string = PROCESS_OWNER,
  ) {}

  /** Every record a previous process left, for a starting Daemon to take over. */
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
        // Written by this very process: its live state is the authority, not the file.
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

  /** Written synchronously and replaced atomically: one small private file, nothing pending
   * outliving the notice it records. */
  save(notice: ImportantUnreadNotice): void {
    try {
      const stateDirectory = this.stateDirectory();
      if (!stateDirectory) return;
      const path = noticePath(stateDirectory, notice.agentId);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
      const temporary = `${path}.tmp`;
      writeFileSync(
        temporary,
        `${JSON.stringify({ version: 1, owner: this.owner, ...notice })}\n`,
        {
          mode: 0o600,
        },
      );
      renameSync(temporary, path);
    } catch (error) {
      // The live state decides delivery; a disk failure must not become a delivery failure.
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
    try {
      unlinkSync(noticePath(stateDirectory, agentId));
    } catch {
      // Already gone, or never written: nothing to clear.
    }
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
      count: typeof record.count === "number" && record.count > 0 ? record.count : 1,
    });
  }
  return conversations;
}

function millis(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}
