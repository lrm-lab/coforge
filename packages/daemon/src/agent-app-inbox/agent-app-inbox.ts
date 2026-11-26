import { z } from "zod";
import {
  APP_INBOX_PREVIEW_MAX_CHARS,
  appInboxDefinition,
  type AppInboxAction,
  type AppInboxRetention,
  type AppSourceRef,
} from "./registry";
import { AgentAppInboxPersistence } from "#src/persistence/agent-app-inbox-store";

export type AgentAppItem = Readonly<{
  itemId: string;
  appId: string;
  notificationClass: string;
  sourceRef: AppSourceRef;
  title?: string;
  summary?: string;
  retention: AppInboxRetention;
  action: AppInboxAction;
  /** The command that acts on this item, when its class has one. */
  command?: string;
  createdAt: string;
}>;

export type MintAppItem = Readonly<{
  appId: string;
  notificationClass: string;
  sourceRef: unknown;
  title?: string;
  summary?: string;
}>;

/** Agent-scoped typed App Inbox. Chat fields and executable actions are not part of its interface.
 * Only `until_explicit_ack` items reach disk; a `transient` item ends with this process. */
export class AgentAppInbox {
  readonly #items = new Map<string, AgentAppItem>();
  readonly #published = new Set<string>();
  /** When a `ttlMs` item is forgotten, by item id: set on every mint, so a re-mint replaces it. */
  readonly #expiresAt = new Map<string, number>();
  #mutations: Promise<unknown> = Promise.resolve();

  private constructor(private readonly persistence: AgentAppInboxPersistence) {}

  static async open(stateDirectory: string, workspaceId: string, agentId: string) {
    const inbox = new AgentAppInbox(
      new AgentAppInboxPersistence(stateDirectory, workspaceId, agentId),
    );
    const [items, oneShots] = await Promise.all([
      inbox.persistence.read(),
      inbox.persistence.readOneShots(),
    ]);
    for (const id of oneShots?.published ?? []) inbox.#published.add(id);
    for (const raw of [...(items ?? []), ...(oneShots?.items ?? [])]) {
      const item = restoreItem(raw);
      if (inbox.#items.has(item.itemId))
        throw new Error("App Inbox persisted identity is duplicated");
      inbox.#items.set(item.itemId, item);
    }
    return inbox;
  }

  list(): AgentAppItem[] {
    this.#dropExpired();
    return [...this.#items.values()].sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.itemId.localeCompare(right.itemId),
    );
  }

  async read(): Promise<AgentAppItem[]> {
    return this.#mutate(async () => {
      const items = this.list();
      const consumed = items.filter(
        (item) => appInboxDefinition(item.appId, item.notificationClass).consumeOnRead,
      );
      for (const item of consumed) this.#items.delete(item.itemId);
      if (consumed.some((item) => item.retention !== "transient")) {
        try {
          await this.#persistOneShots();
        } catch (error) {
          for (const item of consumed) this.#items.set(item.itemId, item);
          throw error;
        }
      }
      return items;
    });
  }

  async upsert(input: MintAppItem): Promise<AgentAppItem> {
    return this.#mutate(() => this.#upsert(input));
  }

  publishOnce(input: MintAppItem, commit: () => Promise<void>): Promise<AgentAppItem | undefined> {
    return this.#mutate(async () => {
      const definition = appInboxDefinition(input.appId, input.notificationClass);
      if (definition.retention === "transient" || !definition.consumeOnRead)
        throw new Error("App Inbox one-shot items require persistent consume-on-read");
      const itemId = definition.itemId(definition.normalizeSourceRef(input.sourceRef));
      if (!this.#published.has(itemId)) {
        this.#published.add(itemId);
        try {
          await this.#upsert(input);
        } catch (error) {
          this.#published.delete(itemId);
          throw error;
        }
      }
      await commit();
      this.#published.delete(itemId);
      await this.#persistOneShots().catch(() => {});
      return this.#items.get(itemId);
    });
  }

  async remove(itemId: string): Promise<boolean> {
    return this.#mutate(async () => {
      const previous = this.#items.get(itemId);
      if (!previous) return false;
      this.#items.delete(itemId);
      this.#expiresAt.delete(itemId);
      if (previous.retention === "transient") return true;
      try {
        await this.#persistItem(previous);
      } catch (error) {
        this.#items.set(itemId, previous);
        throw error;
      }
      return true;
    });
  }

  async #upsert(input: MintAppItem): Promise<AgentAppItem> {
    const definition = appInboxDefinition(input.appId, input.notificationClass);
    const sourceRef = definition.normalizeSourceRef(input.sourceRef);
    const itemId = definition.itemId(sourceRef);
    const previous = this.#items.get(itemId);
    const title = boundedSingleLine(input.title, "title");
    const summary = boundedSingleLine(input.summary, "summary", definition.summaryMaxChars);
    const item: AgentAppItem = Object.freeze({
      itemId,
      appId: input.appId,
      notificationClass: input.notificationClass,
      sourceRef,
      ...(title === undefined ? {} : { title }),
      ...(summary === undefined ? {} : { summary }),
      retention: definition.retention,
      action: definition.action,
      ...(definition.command ? { command: definition.command(sourceRef) } : {}),
      createdAt: previous?.createdAt ?? new Date().toISOString(),
    });
    this.#items.set(itemId, item);
    if (definition.ttlMs === undefined) this.#expiresAt.delete(itemId);
    else this.#expiresAt.set(itemId, Date.now() + definition.ttlMs);
    if (item.retention === "transient") return item;
    try {
      await this.#persistItem(item);
    } catch (error) {
      if (previous) this.#items.set(itemId, previous);
      else this.#items.delete(itemId);
      throw error;
    }
    return item;
  }

  #dropExpired(): void {
    const now = Date.now();
    for (const [itemId, at] of this.#expiresAt)
      if (at <= now) {
        this.#items.delete(itemId);
        this.#expiresAt.delete(itemId);
      }
  }

  #persistItem(item: AgentAppItem): Promise<void> {
    if (isOneShot(item)) return this.#persistOneShots();
    return this.persistence.write(
      this.list().filter((entry) => entry.retention !== "transient" && !isOneShot(entry)),
    );
  }

  #persistOneShots(): Promise<void> {
    return this.persistence.writeOneShots(this.list().filter(isOneShot), [...this.#published]);
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#mutations.then(operation, operation);
    this.#mutations = next.catch(() => {});
    return next;
  }
}

function isOneShot(item: AgentAppItem): boolean {
  return (
    item.retention !== "transient" &&
    appInboxDefinition(item.appId, item.notificationClass).consumeOnRead === true
  );
}

function boundedSingleLine(
  value: unknown,
  field: string,
  maxChars = APP_INBOX_PREVIEW_MAX_CHARS,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    typeof value !== "string" ||
    value.length > maxChars ||
    [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  )
    throw new Error(`App Inbox ${field} must be bounded single-line text`);
  return value;
}

const persistedActionSchema = z.strictObject({
  kind: z.string(),
  commandId: z.string(),
});

const persistedItemSchema = z.strictObject({
  itemId: z.unknown().optional(),
  appId: z.string(),
  notificationClass: z.string(),
  sourceRef: z.unknown().optional(),
  title: z.unknown().optional(),
  summary: z.unknown().optional(),
  retention: z.unknown().optional(),
  action: z.unknown().optional(),
  command: z.unknown().optional(),
  createdAt: z.unknown().optional(),
});

const isoDateStringSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)));

function restoreItem(raw: unknown): AgentAppItem {
  const envelope = persistedItemSchema.safeParse(raw);
  if (!envelope.success) throw new Error("App Inbox persisted item is corrupt");
  const value = envelope.data;
  const definition = appInboxDefinition(value.appId, value.notificationClass);
  const sourceRef = definition.normalizeSourceRef(value.sourceRef);
  const action = persistedActionSchema.safeParse(value.action);
  const createdAt = isoDateStringSchema.safeParse(value.createdAt);
  if (
    definition.retention === "transient" ||
    value.itemId !== definition.itemId(sourceRef) ||
    value.retention !== definition.retention ||
    !action.success ||
    action.data.kind !== definition.action.kind ||
    action.data.commandId !== definition.action.commandId ||
    !createdAt.success
  )
    throw new Error("App Inbox persisted item is corrupt");
  const title = boundedSingleLine(value.title, "title");
  const summary = boundedSingleLine(value.summary, "summary", definition.summaryMaxChars);
  return Object.freeze({
    itemId: value.itemId,
    appId: value.appId,
    notificationClass: value.notificationClass,
    sourceRef,
    ...(title === undefined ? {} : { title }),
    ...(summary === undefined ? {} : { summary }),
    retention: definition.retention,
    action: definition.action,
    ...(definition.command ? { command: definition.command(sourceRef) } : {}),
    createdAt: createdAt.data,
  });
}
