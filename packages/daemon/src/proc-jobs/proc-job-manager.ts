import { rm } from "node:fs/promises";
import { getLogger } from "@logtape/logtape";
import {
  PROC_EXITED_KEPT_PER_AGENT,
  PROC_LOG_MAX_BYTES,
  PROC_MAX_JOBS_PER_AGENT,
  type AgentProcListResponse,
  type AgentProcLogsRequest,
  type AgentProcLogsResponse,
  type AgentProcStartRequest,
  type AgentProcStartResponse,
  type AgentProcStopReason,
  type AgentProcStopRequest,
  type AgentProcStopResponse,
} from "@lrm/coforge-sdk/agent";
import { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import { systemdPresent } from "#src/daemon-host/detached";
import {
  detectUserSystemdRun,
  procJobMayBeRunning,
  readProcJobIdentity,
  stopVerifiedProcJob,
} from "#src/platform/proc-job-process";
import { ProcJobError } from "./proc-job-error";
import { launchAgentProcJob } from "./proc-job-launch";
import {
  markProcJobExited,
  procJobLedgerPath,
  readProcJobLedger,
  removeWorkspaceProcJobLedger,
  toPublicProcJob,
  writeProcJobLedger,
  type StoredProcJob,
} from "./proc-job-ledger";
import {
  agentProcLogsDirectory,
  readProcJobLogSlice,
  removeProcJobLogFiles,
  rotateProcLogIfNeeded,
} from "./proc-job-logs";
import { stopProcJobTargets } from "./proc-job-stop";

const logger = getLogger(["coforge", "daemon", "proc"]);
const DEFAULT_SWEEP_MS = 15_000;

export type ProcJobManagerOptions = {
  workspaceId: string;
  workspaceRoot: string;
  stateDirectory: string;
  platform?: NodeJS.Platform;
  maxJobsPerAgent?: number;
  exitedKeptPerAgent?: number;
  maxLogBytes?: number;
  graceMs?: number;
  killWaitMs?: number;
  sweepIntervalMs?: number;
  systemdRunAvailable?: () => Promise<boolean>;
  systemdPresentCheck?: () => boolean;
  readIdentity?: typeof readProcJobIdentity;
  retainSampledProcessGroup?: boolean;
};

export class ProcJobManager {
  readonly #options: Required<
    Pick<
      ProcJobManagerOptions,
      | "workspaceId"
      | "workspaceRoot"
      | "stateDirectory"
      | "platform"
      | "maxJobsPerAgent"
      | "exitedKeptPerAgent"
      | "maxLogBytes"
      | "graceMs"
      | "killWaitMs"
      | "sweepIntervalMs"
      | "systemdRunAvailable"
      | "systemdPresentCheck"
      | "retainSampledProcessGroup"
    >
  >;
  readonly #readIdentity?: typeof readProcJobIdentity;
  readonly #jobs = new Map<string, StoredProcJob[]>();
  readonly #queues = new Map<string, Promise<unknown>>();
  #adoptPromise: Promise<void> | undefined;
  #writeQueue: Promise<void> = Promise.resolve();
  #sweepTimer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #purged = false;
  #purging: Promise<void> | undefined;

  constructor(options: ProcJobManagerOptions) {
    const platform = options.platform ?? process.platform;
    let cachedSystemdRun: Promise<boolean> | undefined;
    this.#readIdentity = options.readIdentity;
    this.#options = {
      workspaceId: options.workspaceId,
      workspaceRoot: options.workspaceRoot,
      stateDirectory: options.stateDirectory,
      platform,
      maxJobsPerAgent: options.maxJobsPerAgent ?? PROC_MAX_JOBS_PER_AGENT,
      exitedKeptPerAgent: options.exitedKeptPerAgent ?? PROC_EXITED_KEPT_PER_AGENT,
      maxLogBytes: options.maxLogBytes ?? PROC_LOG_MAX_BYTES,
      graceMs: options.graceMs ?? 10_000,
      killWaitMs: options.killWaitMs ?? 2_000,
      sweepIntervalMs: options.sweepIntervalMs ?? DEFAULT_SWEEP_MS,
      systemdRunAvailable:
        options.systemdRunAvailable ??
        (() => (cachedSystemdRun ??= detectUserSystemdRun(platform))),
      systemdPresentCheck: options.systemdPresentCheck ?? systemdPresent,
      retainSampledProcessGroup: options.retainSampledProcessGroup ?? false,
    };
  }

  #ensureAdopted(): Promise<void> {
    if (!this.#adoptPromise) {
      this.#adoptPromise = this.#adopt();
    }
    return this.#adoptPromise;
  }

  async #adopt(): Promise<void> {
    const stored = await readProcJobLedger(procJobLedgerPath(this.#options.stateDirectory));
    let dirty = false;
    const reconciled = await Promise.all(
      stored.map(async (record) => {
        if (record.status !== "running") return record;
        if (await procJobMayBeRunning(record, this.#options.platform)) return record;
        dirty = true;
        return markProcJobExited(record, "exited");
      }),
    );
    for (const current of reconciled) {
      const list = this.#jobs.get(current.agentId) ?? [];
      list.push(current);
      this.#jobs.set(current.agentId, list);
    }
    if (dirty) await this.#persistLedger();
    this.#ensureSweepTimer();
  }

  #ensureSweepTimer(): void {
    if (!this.#closed && !this.#sweepTimer) {
      this.#sweepTimer = setInterval(() => {
        void this.#sweepAll().catch(() => {});
      }, this.#options.sweepIntervalMs);
      this.#sweepTimer.unref();
    }
  }

  startSweep(): void {
    if (this.#purged) return;
    this.#closed = false;
    if (this.#adoptPromise) {
      this.#ensureSweepTimer();
      void this.#sweepAll().catch(() => {});
      return;
    }
    void this.#ensureAdopted().catch(() => {});
  }

  #enqueueAgent<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#queues.get(agentId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        if (this.#queues.get(agentId) === settled) this.#queues.delete(agentId);
      });
    this.#queues.set(agentId, settled);
    return next;
  }

  #persistLedger(): Promise<void> {
    if (this.#purged) return this.#writeQueue;
    const snapshot: StoredProcJob[] = [];
    for (const list of this.#jobs.values()) snapshot.push(...list);
    const ledgerPath = procJobLedgerPath(this.#options.stateDirectory);
    this.#writeQueue = this.#writeQueue.then(
      () => writeProcJobLedger(ledgerPath, snapshot),
      () => writeProcJobLedger(ledgerPath, snapshot),
    );
    return this.#writeQueue;
  }

  async #reconcileAgent(agentId: string): Promise<StoredProcJob[]> {
    const list = this.#jobs.get(agentId) ?? [];
    let dirty = false;
    const next = await Promise.all(
      list.map(async (record) => {
        if (record.status !== "running") return record;
        if (await procJobMayBeRunning(record, this.#options.platform)) {
          await rotateProcLogIfNeeded(record.logPath, this.#options.maxLogBytes).catch(() => {});
          return record;
        }
        dirty = true;
        return markProcJobExited(record, "exited");
      }),
    );
    this.#jobs.set(agentId, next);
    if (dirty) {
      await this.#pruneExited(agentId);
      await this.#persistLedger();
    }
    return this.#jobs.get(agentId) ?? next;
  }

  async #pruneExited(agentId: string): Promise<void> {
    const list = this.#jobs.get(agentId) ?? [];
    const running = list.filter((j) => j.status === "running");
    const exited = list.filter((j) => j.status === "exited");
    if (exited.length <= this.#options.exitedKeptPerAgent) return;
    exited.sort((a, b) => (b.exitedAt ?? b.startedAt).localeCompare(a.exitedAt ?? a.startedAt));
    const keptExited = exited.slice(0, this.#options.exitedKeptPerAgent);
    const dropped = exited.slice(this.#options.exitedKeptPerAgent);
    this.#jobs.set(agentId, [...running, ...keptExited]);
    await Promise.all(dropped.map((job) => removeProcJobLogFiles(job.logPath)));
  }

  async #sweepAll(): Promise<void> {
    if (this.#closed) return;
    await this.#ensureAdopted();
    await Promise.all(
      Array.from(this.#jobs.keys(), (agentId) =>
        this.#enqueueAgent(agentId, () => this.#reconcileAgent(agentId)),
      ),
    );
  }

  list(agentId: string): Promise<AgentProcListResponse> {
    return this.#enqueueAgent(agentId, async () => {
      if (this.#purged)
        throw new ProcJobError("proc_runtime_restricted", 403, "Workspace has been removed.");
      await this.#ensureAdopted();
      if (this.#purged)
        throw new ProcJobError("proc_runtime_restricted", 403, "Workspace has been removed.");
      const jobs = await this.#reconcileAgent(agentId);
      return {
        ok: true,
        jobs: jobs.map(toPublicProcJob),
        limit: this.#options.maxJobsPerAgent,
      };
    });
  }

  start(input: {
    agentId: string;
    provider: string | undefined;
    agentEnvVars?: Readonly<Record<string, string>>;
    request: AgentProcStartRequest;
  }): Promise<AgentProcStartResponse> {
    const { agentId, provider, agentEnvVars, request } = input;
    return this.#enqueueAgent(agentId, async () => {
      if (this.#purged)
        throw new ProcJobError("proc_runtime_restricted", 403, "Workspace has been removed.");
      await this.#ensureAdopted();
      if (this.#purged)
        throw new ProcJobError("proc_runtime_restricted", 403, "Workspace has been removed.");
      const list = await this.#reconcileAgent(agentId);
      const finalRecord = await launchAgentProcJob({
        agentId,
        workspaceId: this.#options.workspaceId,
        workspaceRoot: this.#options.workspaceRoot,
        platform: this.#options.platform,
        provider,
        agentEnvVars,
        request,
        existingJobs: list,
        maxJobsPerAgent: this.#options.maxJobsPerAgent,
        systemdRunAvailable: this.#options.systemdRunAvailable,
        systemdPresentCheck: this.#options.systemdPresentCheck,
        readIdentity: this.#readIdentity,
        retainSampledProcessGroup: this.#options.retainSampledProcessGroup,
        onLateExit: (jobId, exitCode, signal) => {
          void this.#recordProcessExit(agentId, jobId, exitCode, signal);
        },
      });
      if (this.#purged) {
        if (finalRecord.status === "running") {
          await stopVerifiedProcJob(finalRecord, {
            force: true,
            graceMs: this.#options.graceMs,
            killWaitMs: this.#options.killWaitMs,
            platform: this.#options.platform,
          }).catch(() => {});
        }
        await removeProcJobLogFiles(finalRecord.logPath);
        throw new ProcJobError("proc_runtime_restricted", 403, "Workspace has been removed.");
      }

      const replacedExited = list.some(
        (item) => item.name === finalRecord.name && item.status === "exited",
      );
      const nextList = list.filter(
        (item) => !(item.name === finalRecord.name && item.status === "exited"),
      );
      nextList.push(finalRecord);
      this.#jobs.set(agentId, nextList);

      await this.#pruneExited(agentId);
      await this.#persistLedger();
      logger.info("Started Agent background job", {
        event: "agent_proc:start",
        agent_id: agentId,
        job_id: finalRecord.id,
        job_name: finalRecord.name,
        pid: finalRecord.pid,
      });

      return {
        ok: true,
        job: toPublicProcJob(finalRecord),
        ...(replacedExited ? { replacedExited: true } : {}),
      };
    });
  }

  async #recordProcessExit(
    agentId: string,
    id: string,
    exitCode: number | null,
    signal: string | null,
  ): Promise<void> {
    if (this.#closed || this.#purged) return;
    await this.#enqueueAgent(agentId, async () => {
      if (this.#purged) return;
      const list = this.#jobs.get(agentId);
      if (!list) return;
      const idx = list.findIndex((job) => job.id === id);
      if (idx === -1 || list[idx]!.status === "exited") return;
      const record = list[idx]!;
      if (record.groupAnchor && (await procJobMayBeRunning(record, this.#options.platform))) return;
      list[idx] = markProcJobExited(record, "exited", exitCode, signal);
      await this.#pruneExited(agentId);
      await this.#persistLedger();
    });
  }

  logs(agentId: string, request: AgentProcLogsRequest): Promise<AgentProcLogsResponse> {
    return this.#enqueueAgent(agentId, async () => {
      if (this.#purged)
        throw new ProcJobError("proc_runtime_restricted", 403, "Workspace has been removed.");
      await this.#ensureAdopted();
      if (this.#purged)
        throw new ProcJobError("proc_runtime_restricted", 403, "Workspace has been removed.");
      const list = await this.#reconcileAgent(agentId);
      const job = list.find((item) => item.name === request.name);
      if (!job)
        throw new ProcJobError("proc_not_found", 404, `No background job named '${request.name}'.`);
      const slice = await readProcJobLogSlice(job.logPath, {
        tail: request.tail,
        offset: request.offset,
      });
      return {
        ok: true,
        job: toPublicProcJob(job),
        ...slice,
      };
    });
  }

  stop(
    agentId: string,
    request: AgentProcStopRequest,
    reason: AgentProcStopReason = "agent_stop",
  ): Promise<AgentProcStopResponse> {
    return this.#enqueueAgent(agentId, async () => {
      if (this.#purged) return { ok: true, stopped: [], alreadyExited: [] };
      await this.#ensureAdopted();
      if (this.#purged) return { ok: true, stopped: [], alreadyExited: [] };
      const list = await this.#reconcileAgent(agentId);
      let targets: StoredProcJob[];
      if (request.all) {
        targets = list.filter((item) => item.status === "running");
      } else {
        const match = list.find((item) => item.name === request.name);
        if (!match)
          throw new ProcJobError(
            "proc_not_found",
            404,
            `No background job named '${request.name}'.`,
          );
        if (match.status === "exited")
          return { ok: true, stopped: [], alreadyExited: [match.name] };
        targets = [match];
      }

      const { stopped, alreadyExited, failedTarget } = await stopProcJobTargets(
        list,
        targets,
        reason,
        this.#options,
        request.force,
      );
      if (this.#purged) return { ok: true, stopped, alreadyExited };
      await this.#pruneExited(agentId);
      await this.#persistLedger();
      if (failedTarget) {
        throw new ProcJobError(
          "proc_stop_failed",
          500,
          `Background job '${failedTarget.name}' (pid ${failedTarget.pid}) did not exit.`,
        );
      }
      return { ok: true, stopped, alreadyExited };
    });
  }

  stopAllForAgent(
    agentId: string,
    reason: AgentProcStopReason,
    options: { force?: boolean } = {},
  ): Promise<AgentProcStopResponse> {
    return this.stop(agentId, { all: true, force: options.force }, reason);
  }

  forgetAgent(agentId: string, reason: AgentProcStopReason): Promise<void> {
    return this.#enqueueAgent(agentId, async () => {
      if (this.#purged) return;
      await this.#ensureAdopted();
      if (this.#purged) return;
      const list = await this.#reconcileAgent(agentId);
      const { failedTarget } = await stopProcJobTargets(
        list,
        list.filter((job) => job.status === "running"),
        reason,
        this.#options,
      );
      if (this.#purged) return;
      if (failedTarget) {
        await this.#persistLedger();
        throw new ProcJobError(
          "proc_stop_failed",
          500,
          `Background job '${failedTarget.name}' (pid ${failedTarget.pid}) did not exit.`,
        );
      }
      this.#jobs.delete(agentId);
      await this.#persistLedger();
      const logsDir = agentProcLogsDirectory(
        agentWorkspaceDirectory(this.#options.workspaceRoot, this.#options.workspaceId, agentId),
      );
      await rm(logsDir, { recursive: true, force: true }).catch(() => {});
      logger.info("Forgot Agent background jobs", {
        event: "agent_proc:forget",
        agent_id: agentId,
        reason,
      });
    });
  }

  purgeWorkspace(): Promise<void> {
    this.#purging ??= this.#runPurgeWorkspace();
    return this.#purging;
  }

  async #runPurgeWorkspace(): Promise<void> {
    this.#purged = true;
    this.close();
    await this.#ensureAdopted().catch(() => {});
    while (this.#queues.size > 0) {
      await Promise.allSettled(this.#queues.values());
    }
    const runningTargets: StoredProcJob[] = [];
    for (const list of this.#jobs.values()) {
      for (const job of list) {
        if (job.status === "running") runningTargets.push(job);
      }
    }
    await Promise.all(
      runningTargets.map((target) =>
        stopVerifiedProcJob(target, {
          graceMs: this.#options.graceMs,
          killWaitMs: this.#options.killWaitMs,
          platform: this.#options.platform,
        }).catch(() => {}),
      ),
    );
    this.#jobs.clear();
    const stateDirectory = this.#options.stateDirectory;
    this.#writeQueue = this.#writeQueue.then(
      () => removeWorkspaceProcJobLedger(stateDirectory),
      () => removeWorkspaceProcJobLedger(stateDirectory),
    );
    await this.#writeQueue;
  }

  close(): void {
    this.#closed = true;
    if (this.#sweepTimer) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = undefined;
    }
  }
}
