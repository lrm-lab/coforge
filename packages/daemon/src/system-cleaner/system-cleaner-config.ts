import type { AgentAppItem, MintAppItem } from "#src/agent-app-inbox/agent-app-inbox";
import { CLEANER_CONFIG_BOUNDS } from "@lrm/coforge-sdk/internal";
import { z } from "zod";
import { SYSTEM_CLEANER_APP_ID } from "#src/agent-app-inbox/registry";
import type { ReminderClock } from "#src/agent-reminder/reminder-clock";
import { isSafePathScope } from "#src/persistence/path-scope";
import type { DiskMeasurement, MemoryMeasurement } from "./system-cleaner-measure";
import type { WorkspaceHeavyPathsMeasurement } from "./workspace-heavy-paths";

function boundedInt(bounds: Readonly<{ min: number; max: number }>, error: string) {
  return z.int({ error }).min(bounds.min, { error }).max(bounds.max, { error });
}

const cleanerConfigSchema = z.strictObject({
  appId: z.literal(SYSTEM_CLEANER_APP_ID, { error: "app_id_mismatch" }),
  ownerAgentId: z
    .string({ error: "owner_agent_id_invalid" })
    .refine(isSafePathScope, { error: "owner_agent_id_invalid" }),
  enabled: z.boolean({ error: "enabled_invalid" }),
  thresholdBytes: boundedInt(CLEANER_CONFIG_BOUNDS.thresholdBytes, "threshold_bytes_invalid"),
  activeContextThresholdBytes: boundedInt(
    CLEANER_CONFIG_BOUNDS.activeContextThresholdBytes,
    "active_context_threshold_bytes_invalid",
  ),
  intervalMs: boundedInt(CLEANER_CONFIG_BOUNDS.intervalMs, "interval_ms_invalid"),
  revision: z.int({ error: "revision_invalid" }).min(0, { error: "revision_invalid" }),
});

export type CleanerConfig = Readonly<{
  appId: typeof SYSTEM_CLEANER_APP_ID;
  ownerAgentId: string;
  enabled: boolean;
  thresholdBytes: number;
  activeContextThresholdBytes: number;
  intervalMs: number;
  revision: number;
}>;

export type CleanerConfigResult =
  | Readonly<{ kind: "applied"; activeSchedules: 0 | 1 }>
  | Readonly<{ kind: "stale"; currentRevision: number }>
  | Readonly<{ kind: "removed"; activeSchedules: 0 }>
  | Readonly<{ kind: "invalid"; reason: string }>;

export type CleanerClock = ReminderClock;

export type CleanerInbox = Readonly<{
  upsert(ownerAgentId: string, item: MintAppItem): Promise<AgentAppItem>;
  remove(ownerAgentId: string, itemId: string): Promise<boolean>;
}>;

export type SystemCleanerOptions = Readonly<{
  agentsDirectory: string;
  inbox: CleanerInbox;
  wake(ownerAgentId: string, itemId: string): Promise<void>;
  clock?: CleanerClock;
  measurementTimeoutMs?: number;
  workspaceHeavyThresholdBytes?: number;
  measureMemoryFile?(path: string): Promise<MemoryMeasurement>;
  measureKnowledgeSize?(root: string): Promise<MemoryMeasurement>;
  measureDiskSpace?(path: string): Promise<DiskMeasurement>;
  scanWorkspaceHeavyPaths?(workspaceDirectory: string): Promise<WorkspaceHeavyPathsMeasurement>;
}>;

export function parseCleanerConfig(raw: unknown): CleanerConfig | string {
  const parsed = cleanerConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const { issues } = parsed.error;
  if (issues.some((issue) => issue.path.length === 0 && issue.code === "invalid_type"))
    return "envelope_not_object";
  if (issues.some((issue) => issue.code === "unrecognized_keys")) return "envelope_unknown_field";
  return issues[0]?.message ?? "envelope_not_object";
}

export function sameConfig(left: CleanerConfig, right: CleanerConfig): boolean {
  return (
    left.enabled === right.enabled &&
    left.thresholdBytes === right.thresholdBytes &&
    left.activeContextThresholdBytes === right.activeContextThresholdBytes &&
    left.intervalMs === right.intervalMs
  );
}
