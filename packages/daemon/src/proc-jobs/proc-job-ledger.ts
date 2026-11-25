import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  PROC_JOB_LEDGER_FILE,
  decodeAgentProcJob,
  type AgentProcJob,
  type AgentProcStopReason,
} from "@lrm/coforge-sdk/agent";
import { isRecord } from "@lrm/coforge-sdk/internal";
import { procJobMayBeRunning, stopVerifiedProcJob } from "#src/platform/proc-job-process";
import {
  decodeProcJobMemoryScopeIdentity,
  type ProcJobMemoryScopeIdentity,
} from "#src/platform/proc-job-systemd-memory";
import { writePrivateFileAtomic } from "#src/platform/private-file";
import { workspaceStateDirectory } from "#src/supervisor/workspace-instance";

export type StoredProcJob = AgentProcJob & {
  agentId: string;
  workspaceId: string;
  startIdentity?: string;
  groupAnchor?: true;
  groupAnchorBootId?: string;
  memoryStopRequested?: true;
  memoryScope?: ProcJobMemoryScopeIdentity;
};

export type RunningProcJobSummary = AgentProcJob & {
  agentId: string;
  workspaceId: string;
};

export type StopMachineProcJobsResult = {
  stopped: RunningProcJobSummary[];
  alreadyExited: RunningProcJobSummary[];
  failed: RunningProcJobSummary[];
};

export function toPublicProcJob(stored: StoredProcJob): AgentProcJob {
  const {
    agentId: _agentId,
    workspaceId: _workspaceId,
    startIdentity: _identity,
    groupAnchor: _groupAnchor,
    groupAnchorBootId: _bootId,
    memoryStopRequested: _memoryStopRequested,
    memoryScope: _memoryScope,
    ...job
  } = stored;
  return job;
}

export function procJobLedgerPath(workspaceStateDir: string): string {
  return join(workspaceStateDir, PROC_JOB_LEDGER_FILE);
}

function decodeStoredProcJob(value: unknown): StoredProcJob | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.agentId !== "string" || !value.agentId.trim()) return undefined;
  if (typeof value.workspaceId !== "string" || !value.workspaceId.trim()) return undefined;
  if (value.startIdentity !== undefined && typeof value.startIdentity !== "string")
    return undefined;
  try {
    const job = decodeAgentProcJob(value);
    const memoryScope =
      job.systemdUnit && job.memory?.mode === "systemd_cgroup"
        ? decodeProcJobMemoryScopeIdentity(value.memoryScope, job.systemdUnit)
        : undefined;
    return {
      ...job,
      ...(memoryScope ? { memoryScope } : {}),
      agentId: value.agentId,
      workspaceId: value.workspaceId,
      ...(value.groupAnchor === true ? { groupAnchor: true } : {}),
      ...(value.memoryStopRequested === true ? { memoryStopRequested: true } : {}),
      ...(typeof value.groupAnchorBootId === "string"
        ? { groupAnchorBootId: value.groupAnchorBootId }
        : {}),
      ...(typeof value.startIdentity === "string" ? { startIdentity: value.startIdentity } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function readProcJobLedger(ledgerPath: string): Promise<StoredProcJob[]> {
  try {
    const raw = JSON.parse(await readFile(ledgerPath, "utf8")) as unknown;
    if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.jobs)) return [];
    const parsed: StoredProcJob[] = [];
    for (const item of raw.jobs) {
      const job = decodeStoredProcJob(item);
      if (job) parsed.push(job);
    }
    return parsed;
  } catch {
    return [];
  }
}

export async function writeProcJobLedger(
  ledgerPath: string,
  jobs: readonly StoredProcJob[],
): Promise<void> {
  await mkdir(join(ledgerPath, ".."), { recursive: true, mode: 0o700 });
  await writePrivateFileAtomic(ledgerPath, JSON.stringify({ version: 1, jobs }));
}

async function collectWorkspaceLedgerPaths(
  coordinatorStateDir: string,
  workspaceId?: string,
): Promise<string[]> {
  if (workspaceId !== undefined) {
    const path = procJobLedgerPath(workspaceStateDirectory(coordinatorStateDir, workspaceId));
    return (await Bun.file(path).exists()) ? [path] : [];
  }
  const workspacesDir = join(coordinatorStateDir, "workspaces");
  let entries;
  try {
    entries = await readdir(workspacesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const candidate = procJobLedgerPath(join(workspacesDir, entry.name));
        return (await Bun.file(candidate).exists()) ? candidate : undefined;
      }),
  );
  return candidates.filter((candidate): candidate is string => candidate !== undefined);
}

export function markProcJobExited(
  record: StoredProcJob,
  reason: AgentProcStopReason,
  exitCode: number | null = null,
  signal: string | null = null,
): StoredProcJob {
  if (record.status === "exited") return record;
  return {
    ...record,
    status: "exited",
    exitedAt: new Date().toISOString(),
    exitCode,
    signal,
    stopReason: reason,
  };
}

export async function listMachineRunningProcJobs(
  coordinatorStateDir: string,
  options: { platform?: NodeJS.Platform; workspaceId?: string } = {},
): Promise<RunningProcJobSummary[]> {
  const platform = options.platform ?? process.platform;
  const ledgerPaths = await collectWorkspaceLedgerPaths(coordinatorStateDir, options.workspaceId);
  const perLedger = await Promise.all(
    ledgerPaths.map(async (ledgerPath) => {
      const jobs = await readProcJobLedger(ledgerPath);
      const checked = await Promise.all(
        jobs.map(async (job): Promise<RunningProcJobSummary | undefined> => {
          if (job.status !== "running") return undefined;
          return (await procJobMayBeRunning(job, platform))
            ? {
                ...toPublicProcJob(job),
                agentId: job.agentId,
                workspaceId: job.workspaceId,
              }
            : undefined;
        }),
      );
      return checked.filter((entry): entry is RunningProcJobSummary => entry !== undefined);
    }),
  );
  return perLedger.flat();
}

export async function stopMachineRunningProcJobs(
  coordinatorStateDir: string,
  options: { platform?: NodeJS.Platform; workspaceId?: string; force?: boolean } = {},
): Promise<StopMachineProcJobsResult> {
  const platform = options.platform ?? process.platform;
  const ledgerPaths = await collectWorkspaceLedgerPaths(coordinatorStateDir, options.workspaceId);
  const result: StopMachineProcJobsResult = { stopped: [], alreadyExited: [], failed: [] };

  await Promise.all(
    ledgerPaths.map(async (ledgerPath) => {
      const jobs = await readProcJobLedger(ledgerPath);
      let dirty = false;
      const nextJobs = await Promise.all(
        jobs.map(async (job) => {
          if (job.status !== "running") return job;
          dirty = true;
          const outcome = await stopVerifiedProcJob(job, { force: options.force, platform });
          const summary = (updated: StoredProcJob): RunningProcJobSummary => ({
            ...toPublicProcJob(updated),
            agentId: updated.agentId,
            workspaceId: updated.workspaceId,
          });
          if (outcome === "stopped") {
            const updated = markProcJobExited(job, "computer_stop");
            result.stopped.push(summary(updated));
            return updated;
          }
          if (outcome === "already_exited") {
            const updated = markProcJobExited(job, "exited");
            result.alreadyExited.push(summary(updated));
            return updated;
          }
          result.failed.push(summary(job));
          return job;
        }),
      );
      if (dirty) await writeProcJobLedger(ledgerPath, nextJobs).catch(() => {});
    }),
  );
  return result;
}

export async function removeWorkspaceProcJobLedger(workspaceStateDir: string): Promise<void> {
  await rm(procJobLedgerPath(workspaceStateDir), { force: true }).catch(() => {});
}
