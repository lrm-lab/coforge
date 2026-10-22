import { parseActivityEntries, type ActivityTrajectoryEntry } from "./activity-entries";
import { AGENT_SERVICE_TIER_OBSERVED, type AgentServiceTierObserved } from "./service-tier";

import { utf8Decoder } from "./text-codec";
export type AgentActivityKind = "online" | "working" | "thinking" | "error" | "offline";

/** Cloud-authored display projection, separate from Daemon process/Activity facts. */
export type AgentDisplaySnapshot = {
  protocolMajor: 1;
  workspaceId: string;
  computerId: string;
  agentId: string;
  revision: number;
  activityKind: AgentActivityKind;
  detailKind: string;
  detail: string;
  entries: ActivityTrajectoryEntry[];
  /** The cloud must be queried again at this deadline; it is not a client reducer rule. */
  expiresAt: number | null;
  /**
   * The Agent's most recently observed context-window reading, display-only —
   * nothing triggers on it. `undefined` on an older server that has never written this field;
   * `null` once written but the process is offline, a different launch/daemon instance started,
   * or no reading has been observed yet for the current one.
   */
  contextUsage?: { usedTokens: number; windowTokens: number; observedAtMs: number } | null;
  /**
   * The service tier the Agent's launch actually observed, display-only — nothing triggers on it.
   * `undefined` on an older server that has never written the field; `null` once written but no
   * observation is current (the process is offline, or a different launch/daemon instance started).
   */
  fastMode?: {
    requested: boolean;
    observed: AgentServiceTierObserved;
    observedAtMs: number;
  } | null;
};

const activityKinds = new Set<AgentActivityKind>([
  "online",
  "working",
  "thinking",
  "error",
  "offline",
]);

/** Parses the cloud-authored browser display protocol at its public boundary. */
export function parseAgentDisplaySnapshot(data: unknown): AgentDisplaySnapshot {
  const value =
    data instanceof Uint8Array ? (JSON.parse(utf8Decoder.decode(data)) as unknown) : data;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid Agent display snapshot");
  const item = value as Record<string, unknown>;
  const nonempty = (field: unknown) => typeof field === "string" && field.length > 0;
  const bounded = (field: unknown, maximum: number) =>
    typeof field === "string" && [...field].length <= maximum;
  if (
    item.protocolMajor !== 1 ||
    !nonempty(item.workspaceId) ||
    !nonempty(item.computerId) ||
    !nonempty(item.agentId) ||
    !Number.isSafeInteger(item.revision) ||
    (item.revision as number) < 1 ||
    !activityKinds.has(item.activityKind as AgentActivityKind) ||
    !bounded(item.detailKind, 128) ||
    !bounded(item.detail, 512) ||
    (item.expiresAt !== null &&
      (typeof item.expiresAt !== "number" ||
        !Number.isFinite(item.expiresAt) ||
        item.expiresAt <= 0)) ||
    (item.activityKind === "offline" ? item.expiresAt !== null : item.expiresAt === null)
  )
    throw new Error("invalid Agent display snapshot");
  const contextUsage = parseContextUsage(item.contextUsage);
  const fastMode = parseFastMode(item.fastMode);
  return {
    protocolMajor: 1,
    workspaceId: item.workspaceId,
    computerId: item.computerId,
    agentId: item.agentId,
    revision: item.revision,
    activityKind: item.activityKind,
    detailKind: item.detailKind,
    detail: item.detail,
    entries: parseActivityEntries(item.entries),
    expiresAt: item.expiresAt,
    ...(contextUsage !== undefined ? { contextUsage } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
  } as AgentDisplaySnapshot;
}

/** Tolerates a missing field (older server) by returning `undefined` — never a thrown error —
 * and validates numbers when present. `null` (written but nothing to show) passes through. */
function parseContextUsage(value: unknown): AgentDisplaySnapshot["contextUsage"] {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid Agent display snapshot");
  const item = value as Record<string, unknown>;
  const positiveInteger = (field: unknown) => Number.isSafeInteger(field) && (field as number) >= 0;
  if (
    !positiveInteger(item.usedTokens) ||
    !Number.isSafeInteger(item.windowTokens) ||
    (item.windowTokens as number) < 1 ||
    !Number.isSafeInteger(item.observedAtMs) ||
    (item.observedAtMs as number) < 1
  )
    throw new Error("invalid Agent display snapshot");
  return {
    usedTokens: item.usedTokens as number,
    windowTokens: item.windowTokens as number,
    observedAtMs: item.observedAtMs as number,
  };
}

/** Same tolerance as `parseContextUsage`: absent (older server) returns `undefined`, `null`
 * (written, nothing current) passes through, present values are validated. */
function parseFastMode(value: unknown): AgentDisplaySnapshot["fastMode"] {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid Agent display snapshot");
  const item = value as Record<string, unknown>;
  if (
    typeof item.requested !== "boolean" ||
    !Object.values(AGENT_SERVICE_TIER_OBSERVED).includes(item.observed as never) ||
    !Number.isSafeInteger(item.observedAtMs) ||
    (item.observedAtMs as number) < 1
  )
    throw new Error("invalid Agent display snapshot");
  return {
    requested: item.requested,
    observed: item.observed as AgentServiceTierObserved,
    observedAtMs: item.observedAtMs as number,
  };
}
