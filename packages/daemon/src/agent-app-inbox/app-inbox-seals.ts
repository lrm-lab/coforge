import { AgentAppInboxSealsPersistence } from "#src/persistence/agent-app-inbox-seals-store";

/** One sealed App Inbox source identity. Without `sourceRevision` the seal names the source alone
 * (a seal placed before the Agent knew which revision it meant). */
export type AppInboxSeal = Readonly<{
  appId: string;
  notificationClass: string;
  sourceKind: string;
  sourceId: string;
  sourceRevision?: string;
  /** Who sealed it and the condition under which it may be released; never evaluated here. */
  owner: string;
  until: string;
  sealedAt: string;
}>;

export type SealRequest = Omit<AppInboxSeal, "sealedAt">;

const MAX_TEXT = 200;
/** Who sealed it is one short line; the release condition may be one or two sentences. */
const MAX_OWNER = 120;
const MAX_UNTIL = 500;

function bounded(value: unknown, field: string, maxChars = MAX_TEXT): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxChars ||
    [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  )
    throw new Error(`App Inbox seal ${field} must be bounded single-line text`);
  return value;
}

/** A seal's revision is the inbox item's positive-integer revision, never free text. */
function revisionText(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value))
    throw new Error("App Inbox seal revision must be a positive integer");
  return value;
}

function sealKey(
  seal: Pick<
    AppInboxSeal,
    "appId" | "notificationClass" | "sourceKind" | "sourceId" | "sourceRevision"
  >,
): string {
  return [
    seal.appId,
    seal.notificationClass,
    seal.sourceKind,
    seal.sourceId,
    seal.sourceRevision ?? "",
  ].join("\u0000");
}

function normalizeSeal(value: unknown): AppInboxSeal {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("App Inbox seal is corrupt");
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "appId",
    "notificationClass",
    "sourceKind",
    "sourceId",
    "sourceRevision",
    "owner",
    "until",
    "sealedAt",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new Error("App Inbox seal is corrupt");
  if (input.sourceRevision !== undefined && typeof input.sourceRevision !== "string")
    throw new Error("App Inbox seal is corrupt");
  if (input.sourceRevision !== undefined && !/^[1-9][0-9]*$/.test(input.sourceRevision))
    throw new Error("App Inbox seal is corrupt");
  if (typeof input.sealedAt !== "string" || !Number.isFinite(Date.parse(input.sealedAt)))
    throw new Error("App Inbox seal is corrupt");
  return Object.freeze({
    appId: bounded(input.appId, "app id"),
    notificationClass: bounded(input.notificationClass, "notification class"),
    sourceKind: bounded(input.sourceKind, "source kind"),
    sourceId: bounded(input.sourceId, "source id"),
    ...(input.sourceRevision === undefined ? {} : { sourceRevision: input.sourceRevision }),
    owner: bounded(input.owner, "owner", MAX_OWNER),
    until: bounded(input.until, "condition", MAX_UNTIL),
    sealedAt: input.sealedAt,
  });
}

/**
 * The Agent's sealed App Inbox source identities, persisted beside its App Inbox items. Sealing an
 * identity that is already sealed updates who sealed it and until when; only an explicit unseal
 * removes it.
 */
export class AgentAppInboxSeals {
  readonly #seals = new Map<string, AppInboxSeal>();
  #mutations: Promise<unknown> = Promise.resolve();

  private constructor(private readonly persistence: AgentAppInboxSealsPersistence) {}

  static async open(stateDirectory: string, workspaceId: string, agentId: string) {
    const seals = new AgentAppInboxSeals(
      new AgentAppInboxSealsPersistence(stateDirectory, workspaceId, agentId),
    );
    for (const raw of (await seals.persistence.read()) ?? []) {
      const seal = normalizeSeal(raw);
      seals.#seals.set(sealKey(seal), seal);
    }
    return seals;
  }

  list(): AppInboxSeal[] {
    return [...this.#seals.values()].sort(
      (left, right) =>
        left.appId.localeCompare(right.appId) ||
        left.notificationClass.localeCompare(right.notificationClass) ||
        left.sourceId.localeCompare(right.sourceId) ||
        (left.sourceRevision ?? "").localeCompare(right.sourceRevision ?? ""),
    );
  }

  /** Seals every requested identity and answers how many are now sealed. */
  seal(entries: readonly SealRequest[]): Promise<number> {
    return this.#mutate(async () => {
      const previous = new Map(this.#seals);
      const sealedAt = new Date().toISOString();
      for (const entry of entries) {
        const seal = Object.freeze({
          appId: bounded(entry.appId, "app id"),
          notificationClass: bounded(entry.notificationClass, "notification class"),
          sourceKind: bounded(entry.sourceKind, "source kind"),
          sourceId: bounded(entry.sourceId, "source id"),
          ...(entry.sourceRevision === undefined
            ? {}
            : { sourceRevision: revisionText(entry.sourceRevision) }),
          owner: bounded(entry.owner, "owner", MAX_OWNER),
          until: bounded(entry.until, "condition", MAX_UNTIL),
          sealedAt,
        });
        this.#seals.set(sealKey(seal), seal);
      }
      try {
        await this.#persist();
      } catch (error) {
        this.#seals.clear();
        for (const [key, seal] of previous) this.#seals.set(key, seal);
        throw error;
      }
      return entries.length;
    });
  }

  /** Removes the seals `matches` selects and answers how many it removed. */
  unseal(matches: (seal: AppInboxSeal) => boolean): Promise<number> {
    return this.#mutate(async () => {
      const previous = new Map(this.#seals);
      let removed = 0;
      for (const [key, seal] of this.#seals)
        if (matches(seal)) {
          this.#seals.delete(key);
          removed++;
        }
      if (removed === 0) return 0;
      try {
        await this.#persist();
      } catch (error) {
        this.#seals.clear();
        for (const [key, seal] of previous) this.#seals.set(key, seal);
        throw error;
      }
      return removed;
    });
  }

  #persist(): Promise<void> {
    return this.persistence.write(this.list());
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#mutations.then(operation, operation);
    this.#mutations = next.catch(() => {});
    return next;
  }
}
