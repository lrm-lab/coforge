import type { AgentAppItem, MintAppItem } from "#src/agent-app-inbox/agent-app-inbox";
import { CLEANER_CONFIG_BOUNDS } from "@lrm/coforge-sdk/internal";
import { SYSTEM_CLEANER_APP_ID } from "#src/agent-app-inbox/registry";
import type { ReminderClock } from "#src/agent-reminder/reminder-clock";
import { isSafePathScope } from "#src/persistence/path-scope";
import type { DiskMeasurement, MemoryMeasurement } from "./system-cleaner-measure";
import type { WorkspaceHeavyPathsMeasurement } from "./workspace-heavy-paths";

const CONFIG_KEYS = new Set([
  "appId",
  "ownerAgentId",
  "enabled",
  "thresholdBytes",
  "activeContextThresholdBytes",
  "intervalMs",
  "revision",
]);

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
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "envelope_not_object";
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).some((key) => !CONFIG_KEYS.has(key))) return "envelope_unknown_field";
  if (row.appId !== SYSTEM_CLEANER_APP_ID) return "app_id_mismatch";
  if (typeof row.ownerAgentId !== "string" || !isSafePathScope(row.ownerAgentId))
    return "owner_agent_id_invalid";
  if (typeof row.enabled !== "boolean") return "enabled_invalid";
  const { thresholdBytes, activeContextThresholdBytes, intervalMs } = CLEANER_CONFIG_BOUNDS;
  if (!withinBounds(row.thresholdBytes, thresholdBytes)) return "threshold_bytes_invalid";
  if (!withinBounds(row.activeContextThresholdBytes, activeContextThresholdBytes))
    return "active_context_threshold_bytes_invalid";
  if (!withinBounds(row.intervalMs, intervalMs)) return "interval_ms_invalid";
  if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 0)
    return "revision_invalid";
  return {
    appId: SYSTEM_CLEANER_APP_ID,
    ownerAgentId: row.ownerAgentId,
    enabled: row.enabled,
    thresholdBytes: row.thresholdBytes as number,
    activeContextThresholdBytes: row.activeContextThresholdBytes as number,
    intervalMs: row.intervalMs as number,
    revision: row.revision as number,
  };
}

function withinBounds(value: unknown, bounds: Readonly<{ min: number; max: number }>): boolean {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= bounds.min &&
    (value as number) <= bounds.max
  );
}

export function sameConfig(left: CleanerConfig, right: CleanerConfig): boolean {
  return (
    left.enabled === right.enabled &&
    left.thresholdBytes === right.thresholdBytes &&
    left.activeContextThresholdBytes === right.activeContextThresholdBytes &&
    left.intervalMs === right.intervalMs
  );
}
