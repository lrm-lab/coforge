import { utf8Encoder } from "@lrm/coforge-sdk/internal";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { z } from "zod";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";

import { publicationData } from "#src/features/realtime/publication-data";
import { AGENT_VISIBILITY } from "./agent-visibility";

/** What the Agent status channels carry, and where: the channel names, the status event and its
 * codec, and the id-only directory and visibility events. No React here, so the server publishes
 * through the same names the page subscribes to. */

export type AgentStatusEvent = {
  agentId: string;
  status: "active" | "inactive";
  expiresAt: number | null;
  daemonInstanceId: string;
  clientSeq: number;
  observedAtMs: number;
};

const AGENT_STATUS_NAMESPACE = "agentstatus:";

/** The status channels live in their own namespace, `agentstatus`, whose short history lets a page
 * tell whether its first subscribe missed anything (task #348). */
export const agentStatusChannel = (workspaceId: string) =>
  `${AGENT_STATUS_NAMESPACE}${workspaceId}`;

/** The re-routed destination for a private Agent's `agent:display` snapshot, the
 * status-channel sibling of `agentActivityChannelForAgent`: only a viewer who can currently see
 * that Agent may hold it (the subscribe proxy checks). */
export const agentStatusChannelForAgent = (workspaceId: string, agentId: string) =>
  `${AGENT_STATUS_NAMESPACE}${workspaceId}:${agentId}`;

/** Where an Agent's `agent:display` is published; the same fail-closed rule as
 * `agentActivityChannelFor`. */
export const agentStatusChannelFor = (workspaceId: string, agentId: string, visibility: string) =>
  visibility === AGENT_VISIBILITY.PUBLIC
    ? agentStatusChannel(workspaceId)
    : agentStatusChannelForAgent(workspaceId, agentId);

/**
 * The status floor a private Agent also publishes on the shared Workspace status channel: its
 * kind, stop reason, expiry and an external Agent's last-seen time — never `detail`,
 * `detailKind`, `entries`, `contextUsage` or `fastMode`, so every member learns whether it is
 * online, working, thinking, errored or offline, and since when, while its Activity stays
 * private. `statusOnly` marks it so a client that also
 * receives the full snapshot on the Agent's own channel never lets this one stand in for it.
 */
export function agentStatusOnlySnapshot(snapshot: AgentDisplaySnapshot): AgentDisplaySnapshot {
  return {
    protocolMajor: 1,
    workspaceId: snapshot.workspaceId,
    computerId: snapshot.computerId,
    agentId: snapshot.agentId,
    revision: snapshot.revision,
    activityKind: snapshot.activityKind,
    detailKind: "",
    detail: "",
    entries: [],
    expiresAt: snapshot.expiresAt,
    ...(snapshot.stopReason !== undefined ? { stopReason: snapshot.stopReason } : {}),
    ...(snapshot.lastSeenAtMs !== undefined ? { lastSeenAtMs: snapshot.lastSeenAtMs } : {}),
    statusOnly: true,
  };
}

/** The one `agent:display` fan-out every publisher shares: the full snapshot on the Agent's own
 * status channel (`channel`, already chosen by visibility), and — for a private Agent — the
 * status floor on the shared Workspace channel, so every member sees whether it is online,
 * working or offline while its Activity stays private. */
export async function publishAgentDisplay(
  publishJson: (channel: string, data: unknown) => Promise<void>,
  channel: string,
  snapshot: AgentDisplaySnapshot,
  isPrivate: boolean,
): Promise<void> {
  await publishJson(channel, { type: "agent:display", ...snapshot });
  if (isPrivate)
    await publishJson(agentStatusChannel(snapshot.workspaceId), {
      type: "agent:display",
      ...agentStatusOnlySnapshot(snapshot),
    });
}

/**
 * The id-only event a visibility change publishes on the shared status channel. A
 * browser that receives it refetches its Agent list, drops the Agent from caches if it can no
 * longer see it, or (re)subscribes to its per-Agent channels if it still can.
 */
export type AgentVisibilityChangedEvent = { type: "agent:visibility_changed"; agentId: string };

/** An Agent's directory identity or visibility changed. The browser refetches its authorized
 * roster rather than trusting an event payload, so private profile fields never cross this
 * shared Workspace channel. */
export type AgentDirectoryChangedEvent = {
  type: typeof REALTIME_EVENTS.agentChanged;
  agentId: string;
  kind: "created" | "updated" | "deleted";
};

const agentDirectoryChangedEventSchema = z.object({
  type: z.literal(REALTIME_EVENTS.agentChanged),
  agentId: z.string(),
  kind: z.enum(["created", "updated", "deleted"]),
});

export function isAgentDirectoryChangedEvent(value: unknown): value is AgentDirectoryChangedEvent {
  return agentDirectoryChangedEventSchema.safeParse(value).success;
}

export type AgentTokenUsageRecordedEvent = {
  type: typeof REALTIME_EVENTS.agentTokenUsageRecorded;
  agentId: string;
};

const agentTokenUsageRecordedEventSchema = z.object({
  type: z.literal(REALTIME_EVENTS.agentTokenUsageRecorded),
  agentId: z.string().min(1),
});

export function isAgentTokenUsageRecordedEvent(
  value: unknown,
): value is AgentTokenUsageRecordedEvent {
  return agentTokenUsageRecordedEventSchema.safeParse(value).success;
}

const agentVisibilityChangedEventSchema = z.object({
  type: z.literal("agent:visibility_changed"),
  agentId: z.string(),
});

export function isAgentVisibilityChangedEvent(
  value: unknown,
): value is AgentVisibilityChangedEvent {
  return agentVisibilityChangedEventSchema.safeParse(value).success;
}

export function encodeAgentStatusEvent(event: AgentStatusEvent): Uint8Array {
  return utf8Encoder.encode(JSON.stringify(event));
}

const agentStatusBase = {
  agentId: z.string(),
  daemonInstanceId: z.string().min(1),
  clientSeq: z.int().min(1),
  observedAtMs: z.int().min(1),
};

const agentStatusEventSchema = z.discriminatedUnion("status", [
  z.object({
    ...agentStatusBase,
    status: z.literal("active"),
    expiresAt: z.number(),
  }),
  z.object({
    ...agentStatusBase,
    status: z.literal("inactive"),
    expiresAt: z.null(),
  }),
]);

export function decodeAgentStatusEvent(data: unknown): AgentStatusEvent {
  const parsed = agentStatusEventSchema.safeParse(publicationData(data));
  if (!parsed.success) throw new Error("invalid Agent status event");
  return parsed.data;
}
