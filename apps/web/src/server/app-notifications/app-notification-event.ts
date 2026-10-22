import type { WorkspaceMemberRole } from "#src/server/workspaces/member-role.server";

/**
 * The events an app can be notified of, each named `<resource>.<what happened>` and paired with
 * the shape of its `data`: the ids and the changed fields, never a record read back for the
 * occasion. Adding an event adds a member here.
 *
 * Raft names Workspace events `server.*`; CoForge calls its Workspace the same thing everywhere
 * else (the read APIs map server to workspace), so the event is `workspace.*`.
 */
export type AppNotificationEventPayload = {
  type: "workspace.member_added";
  data: { userId: string; role: WorkspaceMemberRole };
};

export type AppNotificationEventType = AppNotificationEventPayload["type"];

/**
 * One app notification event, the envelope of a Standard Webhooks message
 * (https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md):
 * `id` is a UUIDv7 that names the event for good, so recording it twice is recording it once.
 */
export type AppNotificationEvent = AppNotificationEventPayload & {
  id: string;
  /** When the event happened (ISO 8601), not when it was delivered. */
  timestamp: string;
  workspaceId: string;
};

export function newAppNotificationEvent(
  input: AppNotificationEventPayload & { workspaceId: string },
): AppNotificationEvent {
  return {
    ...input,
    id: Bun.randomUUIDv7(),
    timestamp: new Date().toISOString(),
  };
}
