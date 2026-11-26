import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  PROC_JOB_LEDGER_FILE,
  decodeAgentProcJob,
  type AgentProcJob,
  type AgentProcStopReason,
} from "@lrm/coforge-sdk/agent";
import { z } from "zod";
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

const nonBlankString = z.string().refine((value) => value.trim().length > 0);

const storedProcJobFieldsSchema = z.object({
  agentId: nonBlankString,
  workspaceId: nonBlankString,
  startIdentity: z.string().optional(),
  groupAnchor: z.literal(true).optional().catch(undefined),
  memoryStopRequested: z.literal(true).optional().catch(undefined),
  groupAnchorBootId: z.string().optional().catch(undefined),
  memoryScope: z.unknown().optional(),
});

const procJobLedgerEnvelopeSchema = z.object({
  version: z.literal(1),
  jobs: z.array(z.unknown()),
  memoryNotices: z.array(z.unknown()).catch([]),
});

function decodeStoredProcJob(value: unknown): StoredProcJob | undefined {
  const fields = storedProcJobFieldsSchema.safeParse(value);
  if (!fields.success) return undefined;
  try {
    const job = decodeAgentProcJob(value);
    const data = fields.data;
    const memoryScope =
      job.systemdUnit && job.memory?.mode === "systemd_cgroup"
        ? decodeProcJobMemoryScopeIdentity(data.memoryScope, job.systemdUnit)
        : undefined;
    return {
      ...job,
      ...(memoryScope ? { memoryScope } : {}),
      agentId: data.agentId,
      workspaceId: data.workspaceId,
      ...(data.groupAnchor === true ? { groupAnchor: true } : {}),
      ...(data.memoryStopRequested === true ? { memoryStopRequested: true } : {}),
      ...(data.groupAnchorBootId !== undefined
        ? { groupAnchorBootId: data.groupAnchorBootId }
        : {}),
      ...(data.startIdentity !== undefined ? { startIdentity: data.startIdentity } : {}),
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
    const parsed = procJobLedgerEnvelopeSchema.safeParse(
      JSON.parse(await readFile(ledgerPath, "utf8")),
    );
    if (parsed.success) {
      const jobs = parsed.data.jobs.map(decodeStoredProcJob).filter((job) => job !== undefined);
      const memoryNotices = parsed.data.memoryNotices
        .map(decodeProcJobMemoryNotice)
        .filter((notice) => notice !== undefined);
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
