import type { RuntimeCliDowngrade, WorkspaceCrashHistory } from "@lrm/coforge-daemon";
import {
  formatMemoryBytes,
  formatMemorySummary,
  isProcessMemoryHigh,
} from "#src/status/process-memory";
import type { ComputerStatusReport } from "#src/status/types";
import type { DoctorCheck } from "./doctor-command";

export function checkMemory(status: ComputerStatusReport): DoctorCheck | undefined {
  const supervisorMemory = status.supervisor.memory;
  const workspaceSamples = status.workspaces.readable
    ? status.workspaces.workspaces.filter((workspace) => workspace.memory !== undefined)
    : [];
  if (!supervisorMemory && workspaceSamples.length === 0) return undefined;

  const high: string[] = [];
  if (supervisorMemory && isProcessMemoryHigh(supervisorMemory)) {
    const pidLabel = status.supervisor.pid !== null ? ` pid ${status.supervisor.pid}` : "";
    high.push(`supervisor${pidLabel}: ${formatMemorySummary(supervisorMemory)}`);
  }
  for (const workspace of workspaceSamples) {
    if (!workspace.memory || !isProcessMemoryHigh(workspace.memory)) continue;
    const label = workspace.workspaceSlug ?? workspace.workspaceId;
    high.push(`${label}: ${formatMemorySummary(workspace.memory)}`);
  }
  if (high.length > 0) {
    return { name: "memory", ok: false, detail: `high process memory: ${high.join("; ")}` };
  }

  const parts: string[] = [];
  if (supervisorMemory) parts.push(`supervisor ${formatMemorySummary(supervisorMemory)}`);
  if (workspaceSamples.length > 0) {
    let totalRss = 0;
    let totalSwap = 0;
    for (const workspace of workspaceSamples) {
      totalRss += workspace.memory!.rssBytes;
      totalSwap += workspace.memory!.swapBytes ?? 0;
    }
    const swapNote = totalSwap > 0 ? ` (${formatMemoryBytes(totalSwap)} swap)` : "";
    parts.push(
      `${workspaceSamples.length} workspace${workspaceSamples.length === 1 ? "" : "s"} total ${formatMemoryBytes(totalRss)} RSS${swapNote}`,
    );
  }
  return { name: "memory", ok: true, detail: parts.join("; ") };
}

export function checkRuntimeCliDowngrades(
  downgrades: readonly RuntimeCliDowngrade[] | undefined,
): DoctorCheck | undefined {
  if (!downgrades || downgrades.length === 0) return undefined;
  const detail = downgrades
    .map(
      (item) =>
        `${item.provider} downgraded from ${item.previousVersion} (${item.previousPath}) to ${item.currentVersion} (${item.currentPath})`,
    )
    .join("; ");
  return { name: "runtime-cli-versions", ok: false, detail };
}

export function checkCrashHistory(
  status: ComputerStatusReport,
  historyByWorkspace: ReadonlyMap<string, WorkspaceCrashHistory> | undefined,
): DoctorCheck | undefined {
  if (!historyByWorkspace || historyByWorkspace.size === 0) return undefined;
  const labelById = new Map<string, string>();
  const disabledIds = new Set<string>();
  if (status.workspaces.readable) {
    for (const workspace of status.workspaces.workspaces) {
      labelById.set(workspace.workspaceId, workspace.workspaceSlug ?? workspace.workspaceId);
      if (!workspace.enabled) disabledIds.add(workspace.workspaceId);
    }
  }
  const entries: string[] = [];
  for (const [workspaceId, history] of historyByWorkspace) {
    if (disabledIds.has(workspaceId)) continue;
    const label = labelById.get(workspaceId) ?? workspaceId;
    if (history.recentCrashes.length > 0) {
      const latest = history.recentCrashes[history.recentCrashes.length - 1]!;
      const count = history.recentCrashes.length;
      entries.push(
        `${label}: ${count} recent unexpected exit${count === 1 ? "" : "s"} (latest ${latest})`,
      );
    } else if (history.degradedAt) {
      entries.push(
        `${label}: degraded since ${history.degradedAt}${history.degradedReason ? ` (${history.degradedReason})` : ""}`,
      );
    }
  }
  if (entries.length === 0) return undefined;
  return { name: "crash-history", ok: false, detail: entries.join("; ") };
}

export function nextDiagnosticDoctorCommand(name: string, detail: string): string | undefined {
  if (name === "memory") {
    const hasSupervisor = /\bsupervisor(?:\s+pid\s+\d+)?:/.test(detail);
    if (hasSupervisor && !detail.includes("; ")) {
      return "coforge-computer restart --supervisor";
    }
    return "coforge-computer restart";
  }
  if (name === "runtime-cli-versions") {
    return "check PATH order and reinstall the latest Code Agent CLI, then run coforge-computer restart";
  }
  if (name === "crash-history") return "coforge-computer logs --workspace <slug>";
  return undefined;
}
