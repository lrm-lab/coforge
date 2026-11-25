import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  PROC_JOB_LEDGER_FILE,
  decodeAgentProcJob,
  type AgentProcJob,
  type AgentProcStopReason,
} from "@lrm/coforge-sdk/agent";
import { isRecord } from "@lrm/coforge-sdk/internal";
import { procJobOwnership, stopVerifiedProcJob } from "#src/platform/proc-job-process";
import {
  decodeProcJobMemoryScopeIdentity,
  type ProcJobMemoryScopeIdentity,
} from "#src/platform/proc-job-systemd-memory";
import { writePrivateFileAtomic } from "#src/platform/private-file";
import { writePrivateJsonRecord } from "#src/persistence/private-json-record";
import { decodeProcJobMemoryNotice, type ProcJobMemoryNotice } from "./proc-job-memory-notices";
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
  ownership?: "verified" | "unknown";
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
  return (await readProcJobLedgerState(ledgerPath)).jobs;
}

export async function readProcJobLedgerState(
  ledgerPath: string,
): Promise<{ jobs: StoredProcJob[]; memoryNotices: ProcJobMemoryNotice[] }> {
  try {
    const raw = JSON.parse(await readFile(ledgerPath, "utf8")) as unknown;
    if (isRecord(raw) && raw.version === 1 && Array.isArray(raw.jobs)) {
      const jobs = raw.jobs.map(decodeStoredProcJob).filter((job) => job !== undefined);
      const memoryNotices = Array.isArray(raw.memoryNotices)
        ? raw.memoryNotices.map(decodeProcJobMemoryNotice).filter((notice) => notice !== undefined)
        : [];
      return { jobs, memoryNotices };
    }
  } catch {}
  return { jobs: [], memoryNotices: [] };
}

export async function writeProcJobLedger(
  ledgerPath: string,
  jobs: readonly StoredProcJob[],
  memoryNotices: readonly ProcJobMemoryNotice[] = [],
  durable = false,
): Promise<void> {
  const value = { version: 1, jobs, ...(memoryNotices.length ? { memoryNotices } : {}) };
  if (durable || memoryNotices.length)
    await writePrivateJsonRecord(ledgerPath, value, { durable: true });
  else await writePrivateFileAtomic(ledgerPath, JSON.stringify(value));
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
          const ownership = await procJobOwnership(job, platform);
          return ownership === "gone"
            ? undefined
            : {
                ...toPublicProcJob(job),
                agentId: job.agentId,
                workspaceId: job.workspaceId,
                ownership,
              };
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
      const { jobs, memoryNotices } = await readProcJobLedgerState(ledgerPath);
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
      if (dirty) await writeProcJobLedger(ledgerPath, nextJobs, memoryNotices).catch(() => {});
    }),
  );
  return result;
}

export async function removeWorkspaceProcJobLedger(workspaceStateDir: string): Promise<void> {
  await rm(procJobLedgerPath(workspaceStateDir), { force: true }).catch(() => {});
}
