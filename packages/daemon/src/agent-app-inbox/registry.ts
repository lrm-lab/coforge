import { RFC_UUID_PATTERN } from "@lrm/coforge-sdk/internal";
import { isSafePathScope } from "#src/persistence/path-scope";

export const APP_INBOX_PREVIEW_MAX_CHARS = 120;

export type AppSourceRef = Readonly<{ kind: string; id: string; revision: string }>;
export type AppInboxAction = Readonly<{ kind: "run_command"; commandId: string }>;

/** `until_explicit_ack` items persist until acknowledged; `transient` items live in this daemon
 * process's memory only and are never written to disk. */
export type AppInboxRetention = "until_explicit_ack" | "transient";

export type AppInboxDefinition = Readonly<{
  retention: AppInboxRetention;
  action: AppInboxAction;
  /** Longest summary this class accepts; defaults to `APP_INBOX_PREVIEW_MAX_CHARS`. */
  summaryMaxChars?: number;
  /** The command that acts on an item of this class, from its source. `inbox check` prints it as
   * the item's `Run:` line, so a summary never has to carry a command. */
  command?: (sourceRef: AppSourceRef) => string;
  /** A `transient` item that is shown once: listing it for the Agent's own read removes it. */
  consumeOnRead?: boolean;
  /** A `transient` item is forgotten this long after it was last minted, read or not. */
  ttlMs?: number;
  normalizeSourceRef(value: unknown): AppSourceRef;
  itemId(sourceRef: AppSourceRef): string;
}>;

/** The App Inbox item one fired reminder revision is shown as: one item per revision, so a later
 * revision of the same reminder is a new item and acknowledging one clears only that one. */
export function reminderDueItemId(reminderId: string, revision: string | number): string {
  return `reminder:${reminderId}:${revision}`;
}

const reminderDue: AppInboxDefinition = {
  retention: "until_explicit_ack",
  action: { kind: "run_command", commandId: "reminder.ack" },
  command: (sourceRef) =>
    `coforge reminder ack --id ${sourceRef.id} --revision ${sourceRef.revision}`,
  normalizeSourceRef(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("reminder sourceRef must be {kind,id,revision}");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => !["kind", "id", "revision"].includes(key)))
      throw new Error("reminder sourceRef contains unknown fields");
    if (input.kind !== "reminder") throw new Error("reminder sourceRef.kind must be reminder");
    if (typeof input.id !== "string" || !RFC_UUID_PATTERN.test(input.id))
      throw new Error("reminder sourceRef.id must be a UUID");
    if (typeof input.revision !== "string" || !/^[1-9][0-9]*$/.test(input.revision))
      throw new Error("reminder sourceRef.revision must be a positive integer string");
    return { kind: "reminder", id: input.id, revision: input.revision };
  },
  itemId(sourceRef) {
    return reminderDueItemId(sourceRef.id, sourceRef.revision);
  },
};

/** The System Cleaner's App Inbox identity: one item per owner Agent per class. */
export const SYSTEM_CLEANER_APP_ID = "system.cleaner";

/** The App Inbox item id of one owner's System Cleaner hint of `notificationClass`. */
export function systemCleanerItemId(notificationClass: string, ownerAgentId: string): string {
  return `cleaner:${notificationClass}:${ownerAgentId}`;
}

/** The System Cleaner's two hint classes and the source kind each one's items carry. */
export const SYSTEM_CLEANER_CLASSES = {
  memory: { notificationClass: "memory_size", sourceKind: "memory_size" },
  disk: { notificationClass: "disk_space", sourceKind: "disk_space" },
} as const;

function systemCleanerHint(
  { notificationClass, sourceKind }: Readonly<{ notificationClass: string; sourceKind: string }>,
  commandId: string,
  command: string,
): AppInboxDefinition {
  return {
    retention: "transient",
    action: { kind: "run_command", commandId },
    command: () => command,
    summaryMaxChars: 240,
    normalizeSourceRef(value) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("cleaner sourceRef must be {kind,id,revision}");
      const input = value as Record<string, unknown>;
      if (Object.keys(input).some((key) => !["kind", "id", "revision"].includes(key)))
        throw new Error("cleaner sourceRef contains unknown fields");
      if (input.kind !== sourceKind)
        throw new Error(`cleaner sourceRef.kind must be ${sourceKind}`);
      if (typeof input.id !== "string" || !isSafePathScope(input.id))
        throw new Error("cleaner sourceRef.id must be a safe owner Agent id");
      if (typeof input.revision !== "string" || !/^(0|[1-9][0-9]*)$/.test(input.revision))
        throw new Error("cleaner sourceRef.revision must be a config revision");
      return { kind: sourceKind, id: input.id, revision: input.revision };
    },
    itemId(sourceRef) {
      return systemCleanerItemId(notificationClass, sourceRef.id);
    },
  };
}

/** The source of the private notice of a new app's client secret to its owner Agent (`app:register`
 * committed): one item per app, in this process's memory only, whose id is the app's client key.
 * It is a system notice source, not an app: it is not in `BUILT_IN_APPS`, so `app list` never names
 * it and it has no config. */
export const APP_REGISTRATION_NOTICE_SOURCE = "system.app_registry";
export const APP_REGISTRY_SECRET_CLASS = "client_secret";

/** The App Inbox item id of the client secret notice for the app `clientKey`. */
export const appClientSecretItemId = (clientKey: string) =>
  `app-registry:${APP_REGISTRY_SECRET_CLASS}:${clientKey}`;

/** How long the secret stays in the Agent's inbox when nobody reads it. */
export const APP_CLIENT_SECRET_TTL_MS = 15 * 60_000;

const appClientSecret: AppInboxDefinition = {
  retention: "transient",
  action: { kind: "run_command", commandId: "app.rotate_secret" },
  command: (sourceRef) => `coforge app rotate-secret --client ${sourceRef.id} --output <new file>`,
  // The summary carries the secret; the command for another one is the item's `Run:` line.
  summaryMaxChars: 420,
  consumeOnRead: true,
  ttlMs: APP_CLIENT_SECRET_TTL_MS,
  normalizeSourceRef(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("app registry sourceRef must be {kind,id,revision}");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => !["kind", "id", "revision"].includes(key)))
      throw new Error("app registry sourceRef contains unknown fields");
    if (input.kind !== "app_registration")
      throw new Error("app registry sourceRef.kind must be app_registration");
    if (typeof input.id !== "string" || !/^[a-z][a-z0-9-]{2,63}$/.test(input.id))
      throw new Error("app registry sourceRef.id must be a client key");
    if (input.revision !== "1") throw new Error("app registry sourceRef.revision must be 1");
    return { kind: "app_registration", id: input.id, revision: "1" };
  },
  itemId(sourceRef) {
    return appClientSecretItemId(sourceRef.id);
  },
};

export const AGENT_APP_REGISTRY: Readonly<
  Record<string, Readonly<Record<string, AppInboxDefinition>>>
> = {
  "system.reminder": { due: reminderDue },
  [SYSTEM_CLEANER_APP_ID]: {
    [SYSTEM_CLEANER_CLASSES.memory.notificationClass]: systemCleanerHint(
      SYSTEM_CLEANER_CLASSES.memory,
      "app.config",
      `coforge app config --app ${SYSTEM_CLEANER_APP_ID}`,
    ),
    [SYSTEM_CLEANER_CLASSES.disk.notificationClass]: systemCleanerHint(
      SYSTEM_CLEANER_CLASSES.disk,
      "manual.workspace_cleanup",
      "coforge manual get workspace-cleanup",
    ),
  },
};

/** Where the daemon itself, for the cloud, leaves an Agent an App Inbox item that no built-in App
 * owns. Keys never collide with `BUILT_IN_APPS` (the daemon test pins both). */
export const SYSTEM_NOTICE_SOURCES: Readonly<
  Record<string, Readonly<Record<string, AppInboxDefinition>>>
> = {
  [APP_REGISTRATION_NOTICE_SOURCE]: { [APP_REGISTRY_SECRET_CLASS]: appClientSecret },
};

export function appInboxDefinition(appId: string, notificationClass: string): AppInboxDefinition {
  const app = AGENT_APP_REGISTRY[appId] ?? SYSTEM_NOTICE_SOURCES[appId];
  if (!app) throw new Error(`unknown App Inbox app: ${appId}`);
  const definition = app[notificationClass];
  if (!definition) throw new Error(`unknown App Inbox class: ${appId}/${notificationClass}`);
  return definition;
}
