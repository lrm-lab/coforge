import { rename } from "node:fs/promises";
import { getLogger } from "@logtape/logtape";
import { join } from "node:path";
import { isSafePathScope } from "./path-scope";
import { writePrivateJsonRecord } from "./private-json-record";

const logger = getLogger(["coforge", "daemon", "inbox"]);

export interface AppNotifiedStore {
  read(agentId: string, sessionId: string | undefined): Promise<readonly string[]>;
  add(agentId: string, sessionId: string | undefined, itemIds: readonly string[]): Promise<void>;
  remove(agentId: string, itemId: string): Promise<void>;
  removeMany?(agentId: string, itemIds: readonly string[]): Promise<void>;
  clear(agentId: string): Promise<void>;
}

type Record = { sessionId: string | undefined; itemIds: readonly string[] };

export class FileAppNotifiedStore implements AppNotifiedStore {
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #cache = new Map<string, Record>();

  constructor(
    private readonly stateDirectory: string,
    private readonly workspaceId: string,
  ) {
    if (!stateDirectory || !isSafePathScope(workspaceId))
      throw new Error("invalid app notified scope");
  }

  #path(agentId: string) {
    if (!isSafePathScope(agentId)) throw new Error("invalid app notified Agent scope");
    return join(this.stateDirectory, "app-notified", this.workspaceId, agentId, "items.json");
  }

  async read(agentId: string, sessionId: string | undefined): Promise<readonly string[]> {
    if (sessionId === undefined) return [];
    if (!this.#queues.has(agentId)) {
      const cached = this.#cache.get(agentId);
      if (cached !== undefined) return cached.sessionId === sessionId ? cached.itemIds : [];
    }
    const record = await this.#serial(agentId, () => this.#load(agentId));
    return record.sessionId === sessionId ? record.itemIds : [];
  }

  add(agentId: string, sessionId: string | undefined, itemIds: readonly string[]): Promise<void> {
    if (sessionId === undefined) return Promise.resolve();
    return this.#serial(agentId, async () => {
      const record = await this.#load(agentId);
      const current = new Set(record.sessionId === sessionId ? record.itemIds : []);
      const before = current.size;
      for (const itemId of itemIds) if (isItemId(itemId)) current.add(itemId);
      if (current.size === before && record.sessionId === sessionId) return;
      await this.#write(agentId, { sessionId, itemIds: [...current] });
    });
  }

  remove(agentId: string, itemId: string): Promise<void> {
    return this.removeMany(agentId, [itemId]);
  }

  removeMany(agentId: string, itemIds: readonly string[]): Promise<void> {
    if (itemIds.length === 0) return Promise.resolve();
    return this.#serial(agentId, async () => {
      const record = await this.#load(agentId);
      if (record.sessionId === undefined) return;
      const current = new Set(record.itemIds);
      let changed = false;
      for (const itemId of itemIds) {
        if (current.delete(itemId)) changed = true;
      }
      if (!changed) return;
      await this.#write(agentId, { sessionId: record.sessionId, itemIds: [...current] });
    });
  }

  clear(agentId: string): Promise<void> {
    return this.#serial(agentId, async () => {
      const record = await this.#load(agentId);
      if (record.sessionId === undefined && record.itemIds.length === 0) return;
      await this.#write(agentId, { sessionId: undefined, itemIds: [] });
    });
  }

  #serial<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.#queues.get(agentId) ?? Promise.resolve()).then(operation, operation);
    const settled = next.catch(() => {});
    this.#queues.set(agentId, settled);
    void settled.finally(() => {
      if (this.#queues.get(agentId) === settled) this.#queues.delete(agentId);
    });
    return next;
  }

  async #load(agentId: string): Promise<Record> {
    const cached = this.#cache.get(agentId);
    if (cached !== undefined) return cached;
    const path = this.#path(agentId);
    const file = Bun.file(path);
    if (!(await file.exists())) {
      const empty: Record = { sessionId: undefined, itemIds: [] };
      this.#cache.set(agentId, empty);
      return empty;
    }
    const text = await file.text();
    try {
      const value = JSON.parse(text) as {
        version?: unknown;
        sessionId?: unknown;
        itemIds?: unknown;
      } | null;
      if (value?.version !== 1 || !Array.isArray(value.itemIds))
        throw new Error("app notified records are corrupt");
      const record: Record = {
        sessionId: isSessionId(value.sessionId) ? value.sessionId : undefined,
        itemIds: value.itemIds.filter((itemId): itemId is string => isItemId(itemId)),
      };
      this.#cache.set(agentId, record);
      return record;
    } catch (error) {
      await this.#quarantine(agentId, path, error);
      const empty: Record = { sessionId: undefined, itemIds: [] };
      this.#cache.set(agentId, empty);
      return empty;
    }
  }

  async #write(agentId: string, record: Record): Promise<void> {
    try {
      await writePrivateJsonRecord(
        this.#path(agentId),
        { version: 1, sessionId: record.sessionId, itemIds: record.itemIds },
        { durable: true },
      );
      this.#cache.set(agentId, record);
    } catch (error) {
      this.#cache.delete(agentId);
      throw error;
    }
  }

  async #quarantine(agentId: string, path: string, error: unknown): Promise<void> {
    const aside = `${path}.corrupt-${Date.now()}`;
    let setAside = true;
    try {
      await rename(path, aside);
    } catch {
      setAside = false;
    }
    logger.error("App Inbox notices were unreadable; this Agent is told about its items again", {
      event: "inbox.app_notified_quarantined",
      agent_id: agentId,
      ...(setAside ? { quarantined_to: aside } : {}),
      error,
    });
  }
}

const isItemId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128;

const isSessionId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
