import { utf8Encoder } from "@lrm/coforge-sdk/internal";

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

export const agentStatusChannel = (workspaceId: string) => `agent:status:${workspaceId}`;

/** The re-routed destination for a private Agent's `agent:display` snapshot, the
 * status-channel sibling of `agentActivityChannelForAgent`: only a viewer who can currently see
 * that Agent is ever issued a subscription token for it. */
export const agentStatusChannelForAgent = (workspaceId: string, agentId: string) =>
  `agent:status:${workspaceId}:${agentId}`;

/** Where an Agent's `agent:display` is published; the same fail-closed rule as
 * `agentActivityChannelFor`. */
export const agentStatusChannelFor = (workspaceId: string, agentId: string, visibility: string) =>
  visibility === AGENT_VISIBILITY.PUBLIC
    ? agentStatusChannel(workspaceId)
    : agentStatusChannelForAgent(workspaceId, agentId);

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
  type: "agent.changed.v1";
  agentId: string;
  kind: "created" | "updated" | "deleted";
};

export function isAgentDirectoryChangedEvent(value: unknown): value is AgentDirectoryChangedEvent {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Reflect.get(value as object, "type") === "agent.changed.v1" &&
    typeof Reflect.get(value as object, "agentId") === "string" &&
    (Reflect.get(value as object, "kind") === "created" ||
      Reflect.get(value as object, "kind") === "updated" ||
      Reflect.get(value as object, "kind") === "deleted")
  );
}

export function isAgentVisibilityChangedEvent(
  value: unknown,
): value is AgentVisibilityChangedEvent {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Reflect.get(value as object, "type") === "agent:visibility_changed" &&
    typeof Reflect.get(value as object, "agentId") === "string"
  );
}

export function encodeAgentStatusEvent(event: AgentStatusEvent): Uint8Array {
  return utf8Encoder.encode(JSON.stringify(event));
}

export function decodeAgentStatusEvent(data: unknown): AgentStatusEvent {
  const value = publicationData(data);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid Agent status event");
  const agentId = Reflect.get(value, "agentId");
  const status = Reflect.get(value, "status");
  const expiresAt = Reflect.get(value, "expiresAt");
  const daemonInstanceId = Reflect.get(value, "daemonInstanceId");
  const clientSeq = Reflect.get(value, "clientSeq");
  const observedAtMs = Reflect.get(value, "observedAtMs");
  if (
    typeof agentId !== "string" ||
    (status !== "active" && status !== "inactive") ||
    (expiresAt !== null && typeof expiresAt !== "number") ||
    (status === "active" && expiresAt === null) ||
    (status === "inactive" && expiresAt !== null) ||
    typeof daemonInstanceId !== "string" ||
    !daemonInstanceId ||
    !Number.isSafeInteger(clientSeq) ||
    clientSeq < 1 ||
    !Number.isSafeInteger(observedAtMs) ||
    observedAtMs < 1
  )
    throw new Error("invalid Agent status event");
  return {
    agentId,
    status,
    expiresAt,
    daemonInstanceId,
    clientSeq,
    observedAtMs,
  };
}
