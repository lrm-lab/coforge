import { RFC_UUID_PATTERN } from "@lrm/coforge-sdk/internal";
import { z } from "zod";
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

function parseSourceRef(
  value: unknown,
  schema: z.ZodType<AppSourceRef>,
  messages: Readonly<{ notObject: string; unknownFields: string }>,
): AppSourceRef {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const { issues } = parsed.error;
  if (issues.some((issue) => issue.path.length === 0 && issue.code === "invalid_type"))
    throw new Error(messages.notObject);
  if (issues.some((issue) => issue.code === "unrecognized_keys"))
    throw new Error(messages.unknownFields);
  throw new Error(issues[0]?.message ?? messages.notObject);
}

const reminderDueSourceRefSchema = z.strictObject({
  kind: z.literal("reminder", { error: "reminder sourceRef.kind must be reminder" }),
  id: z
    .string({ error: "reminder sourceRef.id must be a UUID" })
    .regex(RFC_UUID_PATTERN, { error: "reminder sourceRef.id must be a UUID" }),
  revision: z
    .string({ error: "reminder sourceRef.revision must be a positive integer string" })
    .regex(/^[1-9][0-9]*$/, {
      error: "reminder sourceRef.revision must be a positive integer string",
    }),
});

const reminderDue: AppInboxDefinition = {
  retention: "until_explicit_ack",
  action: { kind: "run_command", commandId: "reminder.ack" },
  command: (sourceRef) =>
    `coforge reminder ack --id ${sourceRef.id} --revision ${sourceRef.revision}`,
  normalizeSourceRef(value) {
    return parseSourceRef(value, reminderDueSourceRefSchema, {
      notObject: "reminder sourceRef must be {kind,id,revision}",
      unknownFields: "reminder sourceRef contains unknown fields",
    });
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
  const sourceRefSchema = z.strictObject({
    kind: z.literal(sourceKind, { error: `cleaner sourceRef.kind must be ${sourceKind}` }),
    id: z
      .string({ error: "cleaner sourceRef.id must be a safe owner Agent id" })
      .refine(isSafePathScope, { error: "cleaner sourceRef.id must be a safe owner Agent id" }),
    revision: z
      .string({ error: "cleaner sourceRef.revision must be a config revision" })
      .regex(/^(0|[1-9][0-9]*)$/, {
        error: "cleaner sourceRef.revision must be a config revision",
      }),
  });
  return {
    retention: "transient",
    action: { kind: "run_command", commandId },
    command: () => command,
    summaryMaxChars: 320,
    normalizeSourceRef(value) {
      return parseSourceRef(value, sourceRefSchema, {
        notObject: "cleaner sourceRef must be {kind,id,revision}",
        unknownFields: "cleaner sourceRef contains unknown fields",
      });
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

const appClientSecretSourceRefSchema = z.strictObject({
  kind: z.literal("app_registration", {
    error: "app registry sourceRef.kind must be app_registration",
  }),
  id: z
    .string({ error: "app registry sourceRef.id must be a client key" })
    .regex(/^[a-z][a-z0-9-]{2,63}$/, { error: "app registry sourceRef.id must be a client key" }),
  revision: z.literal("1", { error: "app registry sourceRef.revision must be 1" }),
});

const appClientSecret: AppInboxDefinition = {
  retention: "transient",
  action: { kind: "run_command", commandId: "app.rotate_secret" },
  command: (sourceRef) => `coforge app rotate-secret --client ${sourceRef.id} --output <new file>`,
  summaryMaxChars: 420,
  consumeOnRead: true,
  ttlMs: APP_CLIENT_SECRET_TTL_MS,
  normalizeSourceRef(value) {
    return parseSourceRef(value, appClientSecretSourceRefSchema, {
      notObject: "app registry sourceRef must be {kind,id,revision}",
      unknownFields: "app registry sourceRef contains unknown fields",
    });
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

const procMemorySourceRefSchema = z.strictObject({
  kind: z.literal("proc_job"),
  id: z.string().regex(RFC_UUID_PATTERN),
  revision: z.literal("1"),
});

const procMemoryLimit: AppInboxDefinition = {
  retention: "until_explicit_ack",
  action: { kind: "run_command", commandId: "proc.list" },
  command: () => "coforge proc list",
  consumeOnRead: true,
  normalizeSourceRef(value) {
    const parsed = procMemorySourceRefSchema.safeParse(value);
    if (!parsed.success) throw new Error("proc memory notice source must identify a job");
    return parsed.data;
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
