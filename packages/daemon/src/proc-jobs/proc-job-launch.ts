import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  PROC_NAME_MAX_LENGTH,
  PROC_NAME_PATTERN,
  type AgentProcStartRequest,
} from "@lrm/coforge-sdk/agent";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import { readProcJobIdentity, spawnDetachedProcJob } from "#src/platform/proc-job-process";
import { runtimeAllowsProcJobs, sanitizeProcJobEnvironment } from "./proc-job-environment";
import { ProcJobError } from "./proc-job-error";
import { markProcJobExited, toPublicProcJob, type StoredProcJob } from "./proc-job-ledger";
import { prepareProcJobLogFile } from "./proc-job-logs";

function deriveAutoJobName(executable: string, runningNames: ReadonlySet<string>): string {
  const raw = basename(executable)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = (raw || "job").slice(0, PROC_NAME_MAX_LENGTH);
  if (!runningNames.has(base)) return base;
  for (let suffix = 2; suffix < 1_000; suffix++) {
    const tag = `-${suffix}`;
    const candidate = `${base.slice(0, Math.max(1, PROC_NAME_MAX_LENGTH - tag.length))}${tag}`;
    if (!runningNames.has(candidate)) return candidate;
  }
  return `job-${randomUUID().slice(0, 8)}`;
}

function systemdScopeName(agentId: string, name: string, id: string): string {
  const safeAgent = agentId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "agent";
  const safeName = name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "job";
  return `coforge-proc-${safeAgent}-${safeName}-${id.slice(0, 8)}.scope`;
}

async function resolveJobCwd(agentWorkspaceDir: string, cwd: string | undefined): Promise<string> {
  const resolvedCwd = cwd ? resolve(agentWorkspaceDir, cwd) : agentWorkspaceDir;
  try {
    const cwdStat = await stat(resolvedCwd);
    if (!cwdStat.isDirectory())
      throw new ProcJobError("proc_invalid_request", 400, `cwd is not a directory: ${resolvedCwd}`);
    return resolvedCwd;
  } catch (error) {
    if (error instanceof ProcJobError) throw error;
    throw new ProcJobError("proc_invalid_request", 400, `cwd does not exist: ${resolvedCwd}`);
  }
}

export async function launchAgentProcJob(input: {
  agentId: string;
  workspaceId: string;
  workspaceRoot: string;
  platform: NodeJS.Platform;
  provider: string | undefined;
  agentEnvVars?: Readonly<Record<string, string>>;
  request: AgentProcStartRequest;
  existingJobs: readonly StoredProcJob[];
  maxJobsPerAgent: number;
  systemdRunAvailable: () => Promise<boolean>;
  systemdPresentCheck: () => boolean;
  onLateExit: (jobId: string, exitCode: number | null, signal: string | null) => void;
  readIdentity?: typeof readProcJobIdentity;
}): Promise<StoredProcJob> {
  if (input.platform !== "darwin" && input.platform !== "linux")
    throw new ProcJobError(
      "proc_unsupported",
      501,
      `Managed background jobs are unsupported on ${input.platform}.`,
    );
  if (!runtimeAllowsProcJobs(input.provider))
    throw new ProcJobError(
      "proc_runtime_restricted",
      403,
      "Current Agent runtime is not permitted to start background jobs.",
    );
  const { request } = input;
  if (
    !Array.isArray(request.command) ||
    request.command.length === 0 ||
    !request.command[0]?.trim()
  )
    throw new ProcJobError("proc_invalid_request", 400, "A non-empty command is required.");
  if (request.name !== undefined && !PROC_NAME_PATTERN.test(request.name))
    throw new ProcJobError("proc_invalid_request", 400, "Invalid job name.");

  const agentWorkspaceDir = agentWorkspaceDirectory(
    input.workspaceRoot,
    input.workspaceId,
    input.agentId,
  );
  const resolvedCwd = await resolveJobCwd(agentWorkspaceDir, request.cwd);
  const running = input.existingJobs.filter((job) => job.status === "running");
  const runningNames = new Set(running.map((job) => job.name));
  const name = request.name ?? deriveAutoJobName(request.command[0], runningNames);

  if (runningNames.has(name))
    throw new ProcJobError(
      "proc_name_exists",
      409,
      `A running job named '${name}' already exists.`,
    );
  if (running.length >= input.maxJobsPerAgent)
    throw new ProcJobError(
      "proc_limit",
      409,
      `Maximum of ${input.maxJobsPerAgent} running background jobs reached.`,
      running.map(toPublicProcJob),
    );

  const env = sanitizeProcJobEnvironment({
    provider: input.provider,
    platform: input.platform,
    agentEnvVars: input.agentEnvVars,
    jobEnv: request.env,
  });

  let logPath: string;
  try {
    logPath = await prepareProcJobLogFile(agentWorkspaceDir, name);
  } catch (error) {
    throw new ProcJobError(
      "proc_invalid_request",
      400,
      `Failed to prepare job log file: ${diagnosticErrorCode(error)}`,
    );
  }

  const id = randomUUID();
  const useUserSystemd = input.platform === "linux" && (await input.systemdRunAvailable());
  const systemdUnit = useUserSystemd ? systemdScopeName(input.agentId, name, id) : undefined;
  const stopsWithService =
    input.platform === "linux" && !useUserSystemd && input.systemdPresentCheck();

  const pendingRecord: StoredProcJob = {
    id,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    name,
    command: [...request.command],
    cwd: resolvedCwd,
    pid: 1,
    pgid: null,
    ...(systemdUnit ? { systemdUnit } : {}),
    ...(stopsWithService ? { stopsWithService: true } : {}),
    status: "running",
    startedAt: new Date().toISOString(),
    logPath,
  };

  let exitedEarly: { exitCode: number | null; signal: string | null } | undefined;
  let spawnSucceeded = false;
  let pid: number;
  try {
    const spawned = await spawnDetachedProcJob({
      command: request.command,
      cwd: resolvedCwd,
      env,
      logPath,
      systemdUnit,
      onExit: (exitCode, signal) => {
        if (!spawnSucceeded) {
          exitedEarly = { exitCode, signal };
          return;
        }
        input.onLateExit(id, exitCode, signal);
      },
    });
    pid = spawned.pid;
  } catch (error) {
    throw new ProcJobError(
      "proc_spawn_failed",
      500,
      `Failed to start command '${request.command[0]}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const readIdentity = input.readIdentity ?? readProcJobIdentity;
  let identity = exitedEarly ? null : await readIdentity(pid, input.platform).catch(() => null);
  if (!identity && !exitedEarly) {
    await Bun.sleep(10);
    if (!exitedEarly) identity = await readIdentity(pid, input.platform).catch(() => null);
  }
  if (!exitedEarly && !identity) {
    let aliveAfterMiss = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as { code?: string }).code === "ESRCH") aliveAfterMiss = false;
    }
    if (!aliveAfterMiss) {
      const exited = markProcJobExited({ ...pendingRecord, pid, pgid: pid }, "exited", null, null);
      spawnSucceeded = true;
      return exited;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    throw new ProcJobError(
      "proc_spawn_failed",
      500,
      "Failed to verify process identity after launch.",
    );
  }
  const record: StoredProcJob = exitedEarly
    ? markProcJobExited(
        { ...pendingRecord, pid, pgid: identity?.pgid ?? pid },
        "exited",
        exitedEarly.exitCode,
        exitedEarly.signal,
      )
    : {
        ...pendingRecord,
        pid,
        pgid: identity?.pgid ?? pid,
        startIdentity: identity!.startIdentity,
      };
  spawnSucceeded = true;
  return record;
}
