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
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import type {
  ImportantUnreadNotice,
  UnreadNoticeConversation,
} from "../daemon-runtime/important-unread-notice";
import { escapePathIdentity, isSafePathScope } from "./path-scope";

const logger = getLogger(["coforge", "daemon", "important-unread"]);

const PROCESS_OWNER = `${process.pid}:${Date.now()}`;

type PendingOp = { kind: "save"; notice: ImportantUnreadNotice } | { kind: "clear" };

export type ImportantUnreadNoticeStoreOptions = Readonly<{
  asyncWrites?: boolean;
}>;

function noticePath(stateDirectory: string, agentId: string): string {
  if (!isSafePathScope(agentId)) throw new Error("invalid Agent state scope");
  return join(stateDirectory, "agent-state", escapePathIdentity(agentId), "important-unread.json");
}

export class ImportantUnreadNoticeStore {
  readonly #preparedDirs = new Set<string>();
  readonly #asyncWrites: boolean;
  readonly #pending = new Map<string, PendingOp>();
  readonly #latest = new Map<string, { gen: number; op: PendingOp }>();
  readonly #scheduled = new Set<string>();
  readonly #running = new Map<string, Promise<void>>();
  #gen = 0;

  constructor(
    private readonly stateDirectory: () => string | undefined,
    private readonly owner: string = PROCESS_OWNER,
    options: ImportantUnreadNoticeStoreOptions = {},
  ) {
    this.#asyncWrites = options.asyncWrites === true;
  }

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
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        const owner = noticeOwnerSchema.safeParse(value);
        if (owner.success && owner.data.owner === this.owner) continue;
        const notice = readNotice(value, agentId);
        if (notice) notices.push(notice);
        else this.#clearSync(agentId);
      } catch {
        if (existsSync(path)) this.#clearSync(agentId);
      }
    }
    return notices;
  }

  save(notice: ImportantUnreadNotice): void {
    if (this.#asyncWrites) {
      this.#enqueue(notice.agentId, { kind: "save", notice });
      return;
    }
    this.#saveSync(notice);
  }

  clear(agentId: string): void {
    if (this.#asyncWrites) {
      this.#enqueue(agentId, { kind: "clear" });
      return;
    }
    this.#clearSync(agentId);
  }

  async flush(): Promise<void> {
    while (this.#pending.size > 0 || this.#running.size > 0) {
      for (const agentId of this.#pending.keys()) {
        if (!this.#running.has(agentId)) this.#startDrain(agentId);
      }
      if (this.#running.size > 0) await Promise.all(this.#running.values());
    }
  }

  flushSync(): void {
    const agents = new Set<string>();
    for (const agentId of this.#pending.keys()) agents.add(agentId);
    for (const agentId of this.#running.keys()) agents.add(agentId);
    for (const agentId of agents) {
      this.#pending.delete(agentId);
      const entry = this.#latest.get(agentId);
      if (!entry) continue;
      const op = entry.op;
      if (this.#running.has(agentId)) this.#latest.set(agentId, { gen: ++this.#gen, op });
      else this.#latest.delete(agentId);
      if (op.kind === "save") this.#saveSync(op.notice);
      else this.#clearSync(agentId);
    }
  }

  #enqueue(agentId: string, op: PendingOp): void {
    this.#latest.set(agentId, { gen: ++this.#gen, op });
    this.#pending.set(agentId, op);
    if (this.#running.has(agentId) || this.#scheduled.has(agentId)) return;
    this.#scheduled.add(agentId);
    queueMicrotask(() => {
      this.#scheduled.delete(agentId);
      if (!this.#running.has(agentId) && this.#pending.has(agentId)) this.#startDrain(agentId);
    });
  }

  #startDrain(agentId: string): void {
    const drain = (async () => {
      while (true) {
        const op = this.#pending.get(agentId);
        if (!op) break;
        const startedGen = this.#latest.get(agentId)?.gen;
        this.#pending.delete(agentId);
        if (op.kind === "save") await this.#saveAsync(op.notice);
        else await this.#clearAsync(agentId);
        const latest = this.#latest.get(agentId);
        if (latest && latest.gen !== startedGen && !this.#pending.has(agentId)) {
          this.#pending.set(agentId, latest.op);
        } else if (!this.#pending.has(agentId) && latest?.gen === startedGen) {
          this.#latest.delete(agentId);
        }
      }
    })();
    const settled = drain
      .catch(() => {})
      .finally(() => {
        if (this.#running.get(agentId) === settled) this.#running.delete(agentId);
        if (this.#pending.has(agentId) && !this.#running.has(agentId)) this.#startDrain(agentId);
      });
    this.#running.set(agentId, settled);
  }

  #saveSync(notice: ImportantUnreadNotice): void {
    try {
      const stateDirectory = this.stateDirectory();
      if (!stateDirectory) return;
      const path = noticePath(stateDirectory, notice.agentId);
      const dir = dirname(path);
      const body = `${JSON.stringify({ version: 1, owner: this.owner, ...notice })}\n`;
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      if (!this.#preparedDirs.has(dir)) this.#prepareDirSync(dir);
      try {
        writeFileSync(temporary, body, { mode: 0o600 });
        renameSync(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.#preparedDirs.delete(dir);
        this.#prepareDirSync(dir);
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

  async #saveAsync(notice: ImportantUnreadNotice): Promise<void> {
    try {
      const stateDirectory = this.stateDirectory();
      if (!stateDirectory) return;
      const path = noticePath(stateDirectory, notice.agentId);
      const dir = dirname(path);
      const body = `${JSON.stringify({ version: 1, owner: this.owner, ...notice })}\n`;
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      if (!this.#preparedDirs.has(dir)) await this.#prepareDirAsync(dir);
      try {
        await writeFile(temporary, body, { mode: 0o600 });
        await rename(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.#preparedDirs.delete(dir);
        await this.#prepareDirAsync(dir);
        await writeFile(temporary, body, { mode: 0o600 });
        await rename(temporary, path);
      }
    } catch (error) {
      logger.warn("Important unread notice could not be recorded", {
        event: "agent.runtime.important_unread_persist_failed",
        agent_id: notice.agentId,
        error_type: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  #clearSync(agentId: string): void {
    try {
      const stateDirectory = this.stateDirectory();
      if (!stateDirectory) return;
      const path = noticePath(stateDirectory, agentId);
      unlinkSync(path);
    } catch {
      return;
    }
  }

  async #clearAsync(agentId: string): Promise<void> {
    try {
      const stateDirectory = this.stateDirectory();
      if (!stateDirectory) return;
      const path = noticePath(stateDirectory, agentId);
      await unlink(path);
    } catch {
      return;
    }
  }

  #prepareDirSync(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.#preparedDirs.add(dir);
  }

  async #prepareDirAsync(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    this.#preparedDirs.add(dir);
  }
}

const noticeOwnerSchema = z.object({ owner: z.unknown().optional() });

const unreadNoticeConversationSchema = z.object({
  conversationId: z.string().min(1),
  firstSequence: z.int(),
  target: z.string().min(1).optional().catch(undefined),
  independentEvent: z.literal(true).optional().catch(undefined),
  lastSequence: z.int().optional().catch(undefined),
  count: z.number().positive().catch(1),
});

const unreadNoticeSchema = z.object({
  highestSequence: z.int().positive(),
  key: z.string().min(1),
  conversations: z.array(z.unknown()),
  attempts: z.number().min(0).catch(0),
  lastAttempt: z.enum(["accepted", "rejected"]).optional().catch(undefined),
  writtenAtMs: z.number().optional().catch(undefined),
  nextAttemptAtMs: z.number().optional().catch(undefined),
});

function readNotice(value: unknown, agentId: string): ImportantUnreadNotice | undefined {
  const parsed = unreadNoticeSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { highestSequence, key, attempts, lastAttempt, writtenAtMs, nextAttemptAtMs } = parsed.data;
  const conversations = readConversations(parsed.data.conversations);
  if (conversations.length === 0) return undefined;
  return {
    agentId,
    key,
    highestSequence,
    conversations,
    attempts,
    ...(lastAttempt !== undefined ? { lastAttempt } : {}),
    ...(writtenAtMs !== undefined ? { writtenAtMs } : {}),
    ...(nextAttemptAtMs !== undefined ? { nextAttemptAtMs } : {}),
  };
}

function readConversations(value: readonly unknown[]): UnreadNoticeConversation[] {
  const conversations: UnreadNoticeConversation[] = [];
  for (const entry of value) {
    const parsed = unreadNoticeConversationSchema.safeParse(entry);
    if (!parsed.success) continue;
    const { conversationId, target, firstSequence, independentEvent, lastSequence, count } =
      parsed.data;
    conversations.push({
      conversationId,
      ...(target !== undefined ? { target } : {}),
      firstSequence,
      ...(independentEvent === true ? { independentEvent: true as const } : {}),
      ...(lastSequence !== undefined && lastSequence >= firstSequence ? { lastSequence } : {}),
      count,
    });
  }
  return conversations;
}
