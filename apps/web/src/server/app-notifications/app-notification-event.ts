import type { APP_NOTIFICATION_EMITTED_EVENTS } from "#src/features/apps/app-notification-events";
import type { AgentPresenceState, ComputerPresenceState } from "./presence-observer";
import type { WorkspaceMemberRole } from "#src/server/workspaces/member-role.server";

/**
 * The events an app can be notified of, each named `<resource>.<what happened>` and paired with
 * the shape of its `data`: the ids and the changed fields, never a record read back for the
 * occasion. Adding an event adds a member here. Keys in `data` are snake_case, as on the wire, and
 * so are the names listed in `fields`.
 *
 * Raft names Workspace events `server.*`; CoForge calls its Workspace the same thing everywhere
 * else (the read APIs map server to workspace), so the event is `workspace.*`.
 */
export type AppNotificationEventPayload =
  | { type: "workspace.member_added"; data: { user_id: string; role: WorkspaceMemberRole } }
  | { type: "workspace.member_removed"; data: { user_id: string } }
  | {
      type: "workspace.member_role_changed";
      data: { user_id: string; previous_role: WorkspaceMemberRole; role: WorkspaceMemberRole };
    }
  | {
      /** `fields` names what changed; the new `name` and `slug` ride along, an icon is a field. */
      type: "workspace.config_updated";
      data: { fields: ("name" | "slug" | "icon")[]; name?: string; slug?: string };
    }
  | { type: "workspace.public_channel_created"; data: { channel_id: string; name: string } }
  | { type: "workspace.public_channel_archived"; data: { channel_id: string } }
  | { type: "channel.archived"; data: { channel_id: string } }
  | { type: "channel.member_added"; data: { channel_id: string } & ChannelMemberData }
  | { type: "channel.member_removed"; data: { channel_id: string } & ChannelMemberData }
  | {
      /** `fields` names what changed; a rename carries the new `name`, a description is not sent. */
      type: "channel.config_updated";
      data: { channel_id: string; fields: ("name" | "description")[]; name?: string };
    }
  | {
      /** A thread exists from its first reply, which is `message_id`; no body is sent. */
      type: "thread.created";
      data: { channel_id: string; thread_root_id: string; message_id: string };
    }
  | {
      /** `fields` names what changed; a picture is `avatar`, whose bytes are not sent. */
      type: "agent.profile_updated";
      data: { agent_id: string; fields: ("display_name" | "description" | "avatar")[] };
    }
  | {
      type: "agent.runtime_changed";
      data: { agent_id: string; previous_runtime: string; runtime: string };
    }
  | {
      /** The model selection moved: `fields` says which of model, provider, reasoning, fast mode. */
      type: "agent.model_changed";
      data: {
        agent_id: string;
        fields: ("model" | "model_provider" | "reasoning" | "fast_mode")[];
        previous_model: string;
        model: string;
      };
    }
  | {
      type: "computer.version_changed";
      data: { computer_id: string; previous_version: string; version: string };
    }
  | { type: "computer.agent_started"; data: { computer_id: string; agent_id: string } }
  | { type: "computer.agent_stopped"; data: { computer_id: string; agent_id: string } }
  | {
      /** The status field moved; an Agent with no status reads `inactive`. Never a heartbeat. */
      type: "agent.status_changed";
      data: {
        agent_id: string;
        from: AgentPresenceState;
        to: AgentPresenceState;
        observed_at: string;
      };
    }
  | { type: "computer.online"; data: ComputerPresenceData }
  | { type: "computer.offline"; data: ComputerPresenceData };

type ComputerPresenceData = {
  computer_id: string;
  from: ComputerPresenceState;
  to: ComputerPresenceState;
  observed_at: string;
};

/** Who a channel membership event is about: a person (by Workspace user id) or an Agent. */
type ChannelMemberData = { user_id: string } | { agent_id: string };

export type AppNotificationEventType = AppNotificationEventPayload["type"];

/** Compile-time: the types recorded here are exactly `APP_NOTIFICATION_EMITTED_EVENTS`, which the
 * editor offers, and so are in the catalog apps subscribe from. Adding an event to one without the
 * other fails the build. */
type EmittedEvent = (typeof APP_NOTIFICATION_EMITTED_EVENTS)[number];
type Both<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const emittedEventsMatchCatalog: Both<AppNotificationEventType, EmittedEvent> = true;

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

/** `id` and `timestamp` are given by an event that is derived rather than written by a
 * transaction (presence), so recording it twice is recording it once. */
export function newAppNotificationEvent(
  input: AppNotificationEventPayload & { workspaceId: string; id?: string; timestamp?: string },
): AppNotificationEvent {
  return {
    ...input,
    id: input.id ?? Bun.randomUUIDv7(),
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
}
