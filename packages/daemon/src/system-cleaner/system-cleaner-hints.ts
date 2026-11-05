import { CLEANER_CONFIG_BOUNDS, CLEANER_APP_ID } from "@lrm/coforge-sdk/internal";
import { SYSTEM_CLEANER_CLASSES } from "#src/agent-app-inbox/registry";
import {
  AGENT_ACTIVE_CONTEXT_FILE,
  AGENT_MEMORY_FILE,
} from "#src/agent-runtime/agent-workspace-path";

const { memory: MEMORY_HINT, activeContext: ACTIVE_CONTEXT_HINT } = SYSTEM_CLEANER_CLASSES;
const CONFIG_COMMAND = `coforge app config --app ${CLEANER_APP_ID}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** The two files a fresh session carries, each measured against its own limit and hinted about in
 * its own words: what to trim differs between the index and the current state. */
export type FileKind = "memory" | "activeContext";

/** One of those files: where it lives, which config key limits it, and how the hint reads. */
export type FileHint = Readonly<{
  path: string;
  label: string;
  thresholdKey: string;
  guidance: string;
  notificationClass: string;
  sourceKind: string;
  maximumBytes: number;
}>;

export const FILE_KINDS = ["memory", "activeContext"] as const;

export const FILE_HINTS: Readonly<Record<FileKind, FileHint>> = {
  memory: {
    path: AGENT_MEMORY_FILE,
    label: AGENT_MEMORY_FILE,
    thresholdKey: "threshold_bytes",
    guidance:
      "Merge duplicate facts, drop stale ones, and move long material to notes/<topic>.md behind a pointer.",
    notificationClass: MEMORY_HINT.notificationClass,
    sourceKind: MEMORY_HINT.sourceKind,
    maximumBytes: CLEANER_CONFIG_BOUNDS.thresholdBytes.max,
  },
  activeContext: {
    path: AGENT_ACTIVE_CONTEXT_FILE,
    label: AGENT_ACTIVE_CONTEXT_FILE,
    thresholdKey: "active_context_threshold_bytes",
    guidance:
      "This is the current state, not a log: overwrite it with the next step, blocker and progress.",
    notificationClass: ACTIVE_CONTEXT_HINT.notificationClass,
    sourceKind: ACTIVE_CONTEXT_HINT.sourceKind,
    maximumBytes: CLEANER_CONFIG_BOUNDS.activeContextThresholdBytes.max,
  },
};

/** What a hint's action does to the file's limit: doubles it, capped at the maximum. */
export function raiseLimitAction(hint: FileHint, thresholdBytes: number): string {
  if (thresholdBytes >= hint.maximumBytes)
    return `The limit is at its maximum; view or lower it with ${CONFIG_COMMAND}`;
  const doubled = thresholdBytes * 2;
  const next = Math.min(doubled, hint.maximumBytes);
  const change =
    next === doubled
      ? "To allow more, double the limit"
      : "To allow more, raise the limit to its maximum";
  return `${change} (or pick a lower value) with ${CONFIG_COMMAND} --set ${hint.thresholdKey}=${next}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export function formatInterval(intervalMs: number): string {
  if (intervalMs % WEEK_MS === 0) return `${intervalMs / WEEK_MS}w`;
  if (intervalMs % DAY_MS === 0) return `${intervalMs / DAY_MS}d`;
  if (intervalMs % 3_600_000 === 0) return `${intervalMs / 3_600_000}h`;
  if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}m`;
  return `${Math.ceil(intervalMs / 1000)}s`;
}
