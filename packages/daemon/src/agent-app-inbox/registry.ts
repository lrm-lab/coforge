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
): AppInboxDefinition {
  return {
    retention: "transient",
    action: { kind: "run_command", commandId },
    // The summary carries the command to run, since an App Inbox item has no command field.
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

export const AGENT_APP_REGISTRY: Readonly<
  Record<string, Readonly<Record<string, AppInboxDefinition>>>
> = {
  "system.reminder": { due: reminderDue },
  [SYSTEM_CLEANER_APP_ID]: {
    [SYSTEM_CLEANER_CLASSES.memory.notificationClass]: systemCleanerHint(
      SYSTEM_CLEANER_CLASSES.memory,
      "app.config",
    ),
    [SYSTEM_CLEANER_CLASSES.disk.notificationClass]: systemCleanerHint(
      SYSTEM_CLEANER_CLASSES.disk,
      "manual.workspace_cleanup",
    ),
  },
};

export function appInboxDefinition(appId: string, notificationClass: string): AppInboxDefinition {
  const app = AGENT_APP_REGISTRY[appId];
  if (!app) throw new Error(`unknown App Inbox app: ${appId}`);
  const definition = app[notificationClass];
  if (!definition) throw new Error(`unknown App Inbox class: ${appId}/${notificationClass}`);
  return definition;
}
