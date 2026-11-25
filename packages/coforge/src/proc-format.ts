import type {
  AgentProcJob,
  AgentProcListResponse,
  AgentProcLogsResponse,
  AgentProcStartResponse,
  AgentProcStopResponse,
} from "@lrm/coforge-sdk/agent";

function formatExitSummary(job: AgentProcJob): string {
  const details: string[] = [];
  if (job.exitCode !== undefined && job.exitCode !== null) details.push(`code=${job.exitCode}`);
  if (job.signal) details.push(`signal=${job.signal}`);
  if (job.stopReason) details.push(`reason=${job.stopReason}`);
  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

function formatProcMemory(job: AgentProcJob): string {
  const memory = job.memory;
  if (!memory) return "";
  const mode =
    memory.mode === "process_group_rss"
      ? "process-group RSS sampling"
      : "systemd cgroup hard limit";
  const usage =
    job.status === "running"
      ? `, usage ${memory.usageBytes === undefined ? "unknown" : memory.usageBytes + " B"}`
      : "";
  const termination = memory.termination === "memory_limit" ? ", stopped at its memory cap" : "";
  return `  memory=${mode} (limit ${memory.limitBytes} B${usage}${termination})`;
}

export function formatProcStart(response: AgentProcStartResponse): string {
  const { job } = response;
  const note = job.stopsWithService
    ? "\nNote: Linux user systemd is unavailable, so this job will stop with the Workspace service."
    : "";
  return `Started background job ${job.name} (pid ${job.pid}, status ${job.status}, log ${job.logPath}).${note}`;
}

export function formatProcList(response: AgentProcListResponse): string {
  const runningCount = response.jobs.filter((job) => job.status === "running").length;
  if (response.jobs.length === 0) return `No background jobs (0/${response.limit} running).`;
  const lines = [`Background jobs (${runningCount}/${response.limit} running):`];
  for (const job of response.jobs) {
    const suffix = job.status === "exited" ? formatExitSummary(job) : "";
    lines.push(
      `  ${job.name}  status=${job.status}${suffix}  pid=${job.pid}  cwd=${job.cwd}  log=${job.logPath}${formatProcMemory(job)}`,
    );
  }
  return lines.join("\n");
}

export function formatProcLogs(response: AgentProcLogsResponse): string {
  const headerNotes: string[] = [];
  if (response.rotated) headerNotes.push("[log rotated; reading from start of current file]");
  if (response.truncated) headerNotes.push("[output truncated to bounded slice]");
  if (headerNotes.length === 0) return response.content;
  if (!response.content) return `${headerNotes.join("\n")}\n`;
  return `${headerNotes.join("\n")}\n${response.content}`;
}

export function formatProcStop(response: AgentProcStopResponse): string {
  const parts: string[] = [];
  for (const job of response.stopped) {
    parts.push(`Stopped ${job.name} (pid ${job.pid}, reason=${job.stopReason ?? "agent_stop"}).`);
  }
  for (const name of response.alreadyExited) {
    parts.push(`${name} had already exited.`);
  }
  return parts.length > 0 ? parts.join("\n") : "No matching running background jobs.";
}
