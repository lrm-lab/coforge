import { rename } from "node:fs/promises";
import { getLogger } from "@logtape/logtape";
import { join } from "node:path";
import { isSafePathScope } from "./path-scope";
import { writePrivateJsonRecord } from "./private-json-record";

const logger = getLogger(["coforge", "daemon", "inbox"]);

/** The App Inbox items one Agent was already told about, kept where the next daemon reads it. */
export interface AppNotifiedStore {
  read(agentId: string): Promise<readonly string[]>;
  add(agentId: string, itemIds: readonly string[]): Promise<void>;
  remove(agentId: string, itemId: string): Promise<void>;
  clear(agentId: string): Promise<void>;
}

export class FileAppNotifiedStore implements AppNotifiedStore {
  readonly #queues = new Map<string, Promise<unknown>>();

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

  async read(agentId: string): Promise<readonly string[]> {
    const path = this.#path(agentId);
    const file = Bun.file(path);
    if (!(await file.exists())) return [];
    const text = await file.text();
    try {
      const value = JSON.parse(text) as { version?: unknown; itemIds?: unknown } | null;
      if (value?.version !== 1 || !Array.isArray(value.itemIds))
        throw new Error("app notified records are corrupt");
      return value.itemIds.filter((itemId): itemId is string => isItemId(itemId));
    } catch (error) {
      await this.#quarantine(agentId, path, error);
      return [];
    }
  }

  add(agentId: string, itemIds: readonly string[]): Promise<void> {
    return this.#serial(agentId, async () => {
      const current = new Set(await this.read(agentId));
      const before = current.size;
      for (const itemId of itemIds) if (isItemId(itemId)) current.add(itemId);
      if (current.size === before) return;
      await this.#write(agentId, current);
    });
  }

  remove(agentId: string, itemId: string): Promise<void> {
    return this.#serial(agentId, async () => {
      const current = new Set(await this.read(agentId));
      if (!current.delete(itemId)) return;
      await this.#write(agentId, current);
    });
  }

  clear(agentId: string): Promise<void> {
    return this.#serial(agentId, () => this.#write(agentId, new Set()));
  }

  #serial(agentId: string, operation: () => Promise<void>): Promise<void> {
    const next = (this.#queues.get(agentId) ?? Promise.resolve()).then(operation, operation);
    const settled = next.catch(() => {});
    this.#queues.set(agentId, settled);
    void settled.finally(() => {
      if (this.#queues.get(agentId) === settled) this.#queues.delete(agentId);
    });
    return next;
  }

  async #write(agentId: string, itemIds: ReadonlySet<string>): Promise<void> {
    await writePrivateJsonRecord(
      this.#path(agentId),
      { version: 1, itemIds: [...itemIds] },
      { durable: true },
    );
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
