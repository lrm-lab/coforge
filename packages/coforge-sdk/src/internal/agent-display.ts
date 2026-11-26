import { z } from "zod";
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
  /**
   * The `runtimeError.errorReason` of the Activity that last preceded the Agent going
   * offline, kept until the next active process reports. `undefined` on an older server
   * that has never written this field; `null` while no stop reason is known.
   */
  stopReason?: string | null;
  /**
   * What the provider said in that Activity (`runtimeError.providerMessage`), redacted: Activity
   * content, so never on the status floor. Absent or `null` under the same rules as `stopReason`,
   * and `null` too when the Daemon sent none.
   */
  stopDetail?: string | null;
  /**
   * The Daemon's own sentence for that failure (the error Activity's `detail`), which the Activity
   * log shows: what failed and what to do, in the runtime's terms. Recorded and cleared with
   * `stopReason`; never on the status floor. Absent on an older server.
   */
  stopMessage?: string | null;
  /**
   * `true` on the status floor a private Agent also publishes on the shared Workspace status
   * channel: `activityKind`, `stopReason` and `expiresAt` only, with `detailKind`, `detail`
   * and `entries` always empty — never what the Agent is doing. Absent on a full snapshot.
   */
  statusOnly?: true;
  lastSeenAtMs?: number | null;
};

const boundedCodePoints = (maximum: number) =>
  z.string().refine((value) => [...value].length <= maximum);

const positiveSafeIntSchema = z.int().min(1);

const contextUsageSchema = z.object({
  usedTokens: z.int().min(0),
  windowTokens: positiveSafeIntSchema,
  observedAtMs: positiveSafeIntSchema,
});

const serviceTierValues = Object.values(AGENT_SERVICE_TIER_OBSERVED) as [
  AgentServiceTierObserved,
  ...AgentServiceTierObserved[],
];

const fastModeSchema = z.object({
  requested: z.boolean(),
  observed: z.enum(serviceTierValues),
  observedAtMs: positiveSafeIntSchema,
});

const agentDisplaySnapshotSchema = z
  .object({
    protocolMajor: z.literal(1),
    workspaceId: z.string().min(1),
    computerId: z.string(),
    agentId: z.string().min(1),
    revision: positiveSafeIntSchema,
    activityKind: z.enum(["online", "working", "thinking", "error", "offline"]),
    detailKind: boundedCodePoints(128),
    detail: boundedCodePoints(512),
    entries: z.unknown(),
    expiresAt: z.number().positive().nullable(),
    contextUsage: contextUsageSchema.nullish(),
    fastMode: fastModeSchema.nullish(),
    stopReason: boundedCodePoints(128).nullish(),
    stopDetail: z.string().nullish(),
    stopMessage: z.string().nullish(),
    statusOnly: z.literal(true).optional(),
    lastSeenAtMs: positiveSafeIntSchema.nullish(),
  })
  .refine((item) =>
    item.activityKind === "offline" ? item.expiresAt === null : item.expiresAt !== null,
  )
  .refine(
    (item) =>
      item.statusOnly === undefined ||
      (item.detailKind === "" &&
        item.detail === "" &&
        Array.isArray(item.entries) &&
        item.entries.length === 0 &&
        item.contextUsage === undefined &&
        item.fastMode === undefined &&
        item.stopDetail === undefined &&
        item.stopMessage === undefined),
  );

export function parseAgentDisplaySnapshot(data: unknown): AgentDisplaySnapshot {
  const value =
    data instanceof Uint8Array ? (JSON.parse(utf8Decoder.decode(data)) as unknown) : data;
  const parsed = agentDisplaySnapshotSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent display snapshot");
  const item = parsed.data;
  return {
    protocolMajor: item.protocolMajor,
    workspaceId: item.workspaceId,
    computerId: item.computerId,
    agentId: item.agentId,
    revision: item.revision,
    activityKind: item.activityKind,
    detailKind: item.detailKind,
    detail: item.detail,
    entries: parseActivityEntries(item.entries),
    expiresAt: item.expiresAt,
    ...(item.contextUsage !== undefined ? { contextUsage: item.contextUsage } : {}),
    ...(item.fastMode !== undefined ? { fastMode: item.fastMode } : {}),
    ...(item.stopReason !== undefined ? { stopReason: item.stopReason } : {}),
    ...(item.stopDetail !== undefined ? { stopDetail: item.stopDetail } : {}),
    ...(item.stopMessage !== undefined ? { stopMessage: item.stopMessage } : {}),
    ...(item.statusOnly ? { statusOnly: item.statusOnly } : {}),
    ...(item.lastSeenAtMs !== undefined ? { lastSeenAtMs: item.lastSeenAtMs } : {}),
  };
}
