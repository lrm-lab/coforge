import { RFC_UUID_PATTERN } from "@lrm/coforge-sdk/internal";
import { isSafePathScope } from "#src/persistence/path-scope";

export const APP_INBOX_PREVIEW_MAX_CHARS = 120;

export type AppSourceRef = Readonly<{ kind: string; id: string; revision: string }>;
export type AppInboxAction = Readonly<{ kind: "run_command"; commandId: string }>;

export type AppInboxRetention = "until_explicit_ack" | "transient";

export type AppInboxDefinition = Readonly<{
  retention: AppInboxRetention;
  action: AppInboxAction;
  summaryMaxChars?: number;
  command?: (sourceRef: AppSourceRef) => string;
  consumeOnRead?: boolean;
  ttlMs?: number;
  normalizeSourceRef(value: unknown): AppSourceRef;
  itemId(sourceRef: AppSourceRef): string;
}>;

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

export const SYSTEM_CLEANER_APP_ID = "system.cleaner";

export function systemCleanerItemId(notificationClass: string, ownerAgentId: string): string {
  return `cleaner:${notificationClass}:${ownerAgentId}`;
}

export const SYSTEM_CLEANER_CLASSES = {
  memory: { notificationClass: "memory_size", sourceKind: "memory_size" },
  activeContext: { notificationClass: "active_context_size", sourceKind: "active_context_size" },
  knowledge: { notificationClass: "knowledge_size", sourceKind: "knowledge_size" },
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
    summaryMaxChars: 320,
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

export const APP_REGISTRATION_NOTICE_SOURCE = "system.app_registry";
export const APP_REGISTRY_SECRET_CLASS = "client_secret";

export const appClientSecretItemId = (clientKey: string) =>
  `app-registry:${APP_REGISTRY_SECRET_CLASS}:${clientKey}`;

export const APP_CLIENT_SECRET_TTL_MS = 15 * 60_000;

const appClientSecret: AppInboxDefinition = {
  retention: "transient",
  action: { kind: "run_command", commandId: "app.rotate_secret" },
  command: (sourceRef) => `coforge app rotate-secret --client ${sourceRef.id} --output <new file>`,
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
    [SYSTEM_CLEANER_CLASSES.knowledge.notificationClass]: systemCleanerHint(
      SYSTEM_CLEANER_CLASSES.knowledge,
      "manual.memory",
      "coforge manual get memory",
    ),
    [SYSTEM_CLEANER_CLASSES.memory.notificationClass]: systemCleanerHint(
      SYSTEM_CLEANER_CLASSES.memory,
      "app.config",
      `coforge app config --app ${SYSTEM_CLEANER_APP_ID}`,
    ),
    [SYSTEM_CLEANER_CLASSES.activeContext.notificationClass]: systemCleanerHint(
      SYSTEM_CLEANER_CLASSES.activeContext,
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

export const PROC_MEMORY_APP_ID = "system.proc";
export const PROC_MEMORY_NOTICE_CLASS = "memory_limit";

const procMemoryLimit: AppInboxDefinition = {
  retention: "until_explicit_ack",
  action: { kind: "run_command", commandId: "proc.list" },
  command: () => "coforge proc list",
  consumeOnRead: true,
  normalizeSourceRef(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("proc memory notice source must identify a job");
    const input = value as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => !["kind", "id", "revision"].includes(key)) ||
      input.kind !== "proc_job" ||
      typeof input.id !== "string" ||
      !RFC_UUID_PATTERN.test(input.id) ||
      input.revision !== "1"
    )
      throw new Error("proc memory notice source must identify a job");
    return { kind: "proc_job", id: input.id, revision: "1" };
  },
  itemId: (sourceRef) => `proc:memory_limit:${sourceRef.id}`,
};

export const SYSTEM_NOTICE_SOURCES: Readonly<
  Record<string, Readonly<Record<string, AppInboxDefinition>>>
> = {
  [PROC_MEMORY_APP_ID]: { [PROC_MEMORY_NOTICE_CLASS]: procMemoryLimit },
  [APP_REGISTRATION_NOTICE_SOURCE]: { [APP_REGISTRY_SECRET_CLASS]: appClientSecret },
};

export function appInboxDefinition(appId: string, notificationClass: string): AppInboxDefinition {
  const app = AGENT_APP_REGISTRY[appId] ?? SYSTEM_NOTICE_SOURCES[appId];
  if (!app) throw new Error(`unknown App Inbox app: ${appId}`);
  const definition = app[notificationClass];
  if (!definition) throw new Error(`unknown App Inbox class: ${appId}/${notificationClass}`);
  return definition;
}
