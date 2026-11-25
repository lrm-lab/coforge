import { isRecord } from "#src/internal/json-record";

export const PROC_CAPABILITY = "proc:v1";
export const PROC_NAME_MAX_LENGTH = 40;
export const PROC_NAME_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
export const PROC_MAX_JOBS_PER_AGENT = 8;
export const PROC_EXITED_KEPT_PER_AGENT = 8;
export const PROC_LOG_MAX_BYTES = 20 * 1024 * 1024;
export const PROC_LOGS_DEFAULT_TAIL = 50;
export const PROC_LOGS_MAX_TAIL = 2_000;
export const PROC_LOGS_FOLLOW_MAX_MS = 30_000;
export const PROC_START_MAX_BODY_BYTES = 256 * 1024;
export const PROC_JOB_LEDGER_FILE = "proc-jobs.json";

export const AGENT_PROC_JOB_STATUSES = ["running", "exited"] as const;
export type AgentProcJobStatus = (typeof AGENT_PROC_JOB_STATUSES)[number];

export const AGENT_PROC_STOP_REASONS = [
  "agent_stop",
  "owner_stop",
  "computer_stop",
  "agent_deleted",
  "migrated",
  "exited",
] as const;
export type AgentProcStopReason = (typeof AGENT_PROC_STOP_REASONS)[number];

export const AGENT_PROC_ERROR_CODES = [
  "proc_limit",
  "proc_name_exists",
  "proc_not_found",
  "proc_invalid_request",
  "proc_runtime_restricted",
  "proc_spawn_failed",
  "proc_stop_failed",
  "proc_unsupported",
] as const;
export type AgentProcErrorCode = (typeof AGENT_PROC_ERROR_CODES)[number];

export type AgentProcMemory = {
  mode: "process_group_rss" | "systemd_cgroup";
  limitBytes: number;
  usageBytes?: number;
  termination?: "memory_limit";
};

export type AgentProcJob = {
  id: string;
  name: string;
  command: string[];
  cwd: string;
  pid: number;
  pgid: number | null;
  systemdUnit?: string;
  stopsWithService?: boolean;
  status: AgentProcJobStatus;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  stopReason?: AgentProcStopReason;
  memory?: AgentProcMemory;
  logPath: string;
};

export type AgentProcListResponse = {
  ok: true;
  jobs: AgentProcJob[];
  limit: number;
};

export type AgentProcStartRequest = {
  command: string[];
  name?: string;
  cwd?: string;
  env?: Record<string, string>;
};

export type AgentProcStartResponse = {
  ok: true;
  job: AgentProcJob;
  replacedExited?: boolean;
};

export type AgentProcLogsRequest = {
  name: string;
  tail?: number;
  offset?: number;
};

export type AgentProcLogsResponse = {
  ok: true;
  job: AgentProcJob;
  content: string;
  nextOffset: number;
  rotated: boolean;
  truncated: boolean;
};

export type AgentProcStopRequest = {
  name?: string;
  all?: boolean;
  force?: boolean;
};

export type AgentProcStopResponse = {
  ok: true;
  stopped: AgentProcJob[];
  alreadyExited: string[];
};

export type AgentProcErrorResponse = {
  ok: false;
  errorCode: AgentProcErrorCode;
  error: string;
  jobs?: AgentProcJob[];
};

const START_KEYS = new Set(["command", "name", "cwd", "env"]);
const LOGS_KEYS = new Set(["name", "tail", "offset"]);
const STOP_KEYS = new Set(["name", "all", "force"]);

function fail(message: string): never {
  throw new Error(message);
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`invalid proc field: ${key}`);
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    fail(`invalid proc ${field}`);
  return value;
}

function requirePlainString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.includes("\0")) fail(`invalid proc ${field}`);
  return value;
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    fail(`invalid proc ${field}`);
  return value;
}

function requireNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail(`invalid proc ${field}`);
  return value;
}

function requireCommandArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) fail("invalid proc command");
  const command = value.map((item, index) => {
    if (typeof item !== "string" || item.includes("\0")) fail("invalid proc command");
    if (index === 0 && !item.trim()) fail("invalid proc command");
    return item;
  });
  return command;
}

function requireJobName(value: unknown): string {
  const name = requireNonEmptyString(value, "name");
  if (!PROC_NAME_PATTERN.test(name)) fail("invalid proc name");
  return name;
}

export function decodeAgentProcJob(value: unknown): AgentProcJob {
  if (!isRecord(value)) fail("invalid proc job");
  const status = value.status;
  if (!AGENT_PROC_JOB_STATUSES.includes(status as AgentProcJobStatus))
    fail("invalid proc job status");
  const pgid = value.pgid === null ? null : requirePositiveInt(value.pgid, "pgid");
  const job: AgentProcJob = {
    id: requireNonEmptyString(value.id, "id"),
    name: requireJobName(value.name),
    command: requireCommandArray(value.command),
    cwd: requireNonEmptyString(value.cwd, "cwd"),
    pid: requirePositiveInt(value.pid, "pid"),
    pgid,
    status: status as AgentProcJobStatus,
    startedAt: requireNonEmptyString(value.startedAt, "startedAt"),
    logPath: requireNonEmptyString(value.logPath, "logPath"),
  };
  if (value.systemdUnit !== undefined)
    job.systemdUnit = requireNonEmptyString(value.systemdUnit, "systemdUnit");
  if (value.stopsWithService !== undefined) {
    if (typeof value.stopsWithService !== "boolean") fail("invalid proc stopsWithService");
    job.stopsWithService = value.stopsWithService;
  }
  if (value.exitedAt !== undefined)
    job.exitedAt = requireNonEmptyString(value.exitedAt, "exitedAt");
  if (value.exitCode !== undefined) {
    if (
      value.exitCode !== null &&
      (typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode))
    )
      fail("invalid proc exitCode");
    job.exitCode = value.exitCode;
  }
  if (value.signal !== undefined) {
    job.signal = value.signal === null ? null : requireNonEmptyString(value.signal, "signal");
  }
  if (value.stopReason !== undefined) {
    if (!AGENT_PROC_STOP_REASONS.includes(value.stopReason as AgentProcStopReason))
      fail("invalid proc stopReason");
    job.stopReason = value.stopReason as AgentProcStopReason;
  }
  if (value.memory !== undefined) {
    const memory = value.memory;
    if (
      !isRecord(memory) ||
      (memory.mode !== "process_group_rss" && memory.mode !== "systemd_cgroup")
    )
      fail("invalid proc memory");
    job.memory = {
      mode: memory.mode,
      limitBytes: requirePositiveInt(memory.limitBytes, "memory limit"),
    };
    if (memory.usageBytes !== undefined)
      job.memory.usageBytes = requireNonNegativeInt(memory.usageBytes, "memory usage");
    if (memory.termination !== undefined) {
      if (memory.termination !== "memory_limit" || job.status !== "exited")
        fail("invalid proc memory termination");
      job.memory.termination = memory.termination;
    }
  }
  return job;
}

export function decodeAgentProcListResponse(value: unknown): AgentProcListResponse {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.jobs))
    fail("invalid proc list response");
  return {
    ok: true,
    jobs: value.jobs.map(decodeAgentProcJob),
    limit: requirePositiveInt(value.limit, "limit"),
  };
}

export function decodeAgentProcStartRequest(value: unknown): AgentProcStartRequest {
  if (!isRecord(value)) fail("invalid proc start request");
  rejectUnknownKeys(value, START_KEYS);
  const request: AgentProcStartRequest = {
    command: requireCommandArray(value.command),
  };
  if (value.name !== undefined) request.name = requireJobName(value.name);
  if (value.cwd !== undefined) request.cwd = requireNonEmptyString(value.cwd, "cwd");
  if (value.env !== undefined) {
    if (!isRecord(value.env)) fail("invalid proc env");
    const entries: [string, string][] = [];
    for (const [key, item] of Object.entries(value.env)) {
      if (!key || key.includes("=") || key.includes("\0")) fail("invalid proc env key");
      entries.push([key, requirePlainString(item, "env value")]);
    }
    request.env = Object.fromEntries(entries);
  }
  return request;
}

export function decodeAgentProcStartResponse(value: unknown): AgentProcStartResponse {
  if (!isRecord(value) || value.ok !== true) fail("invalid proc start response");
  if (value.replacedExited !== undefined && typeof value.replacedExited !== "boolean")
    fail("invalid proc replacedExited");
  return {
    ok: true,
    job: decodeAgentProcJob(value.job),
    ...(value.replacedExited === undefined ? {} : { replacedExited: value.replacedExited }),
  };
}

export function decodeAgentProcLogsRequest(value: unknown): AgentProcLogsRequest {
  if (!isRecord(value)) fail("invalid proc logs request");
  rejectUnknownKeys(value, LOGS_KEYS);
  const request: AgentProcLogsRequest = {
    name: requireJobName(value.name),
  };
  if (value.tail !== undefined) {
    const tail = requireNonNegativeInt(value.tail, "tail");
    if (tail > PROC_LOGS_MAX_TAIL) fail("invalid proc tail");
    request.tail = tail;
  }
  if (value.offset !== undefined) {
    request.offset = requireNonNegativeInt(value.offset, "offset");
  }
  return request;
}

export function decodeAgentProcLogsResponse(value: unknown): AgentProcLogsResponse {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.rotated !== "boolean" ||
    typeof value.truncated !== "boolean"
  )
    fail("invalid proc logs response");
  return {
    ok: true,
    job: decodeAgentProcJob(value.job),
    content: requirePlainString(value.content, "content"),
    nextOffset: requireNonNegativeInt(value.nextOffset, "nextOffset"),
    rotated: value.rotated,
    truncated: value.truncated,
  };
}

export function decodeAgentProcStopRequest(value: unknown): AgentProcStopRequest {
  if (!isRecord(value)) fail("invalid proc stop request");
  rejectUnknownKeys(value, STOP_KEYS);
  if (value.all !== undefined && typeof value.all !== "boolean") fail("invalid proc all");
  if (value.force !== undefined && typeof value.force !== "boolean") fail("invalid proc force");
  const name = value.name !== undefined ? requireJobName(value.name) : undefined;
  const all = value.all === true;
  if ((name !== undefined && all) || (name === undefined && !all))
    fail("proc stop requires either name or all=true");
  return {
    ...(name !== undefined ? { name } : {}),
    ...(value.all !== undefined ? { all: value.all } : {}),
    ...(value.force !== undefined ? { force: value.force } : {}),
  };
}

export function decodeAgentProcStopResponse(value: unknown): AgentProcStopResponse {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !Array.isArray(value.stopped) ||
    !Array.isArray(value.alreadyExited)
  )
    fail("invalid proc stop response");
  return {
    ok: true,
    stopped: value.stopped.map(decodeAgentProcJob),
    alreadyExited: value.alreadyExited.map((item) => requireJobName(item)),
  };
}

export function decodeAgentProcErrorResponse(value: unknown): AgentProcErrorResponse {
  if (!isRecord(value) || value.ok !== false) fail("invalid proc error response");
  const errorCode = value.errorCode;
  if (!AGENT_PROC_ERROR_CODES.includes(errorCode as AgentProcErrorCode))
    fail("invalid proc errorCode");
  const response: AgentProcErrorResponse = {
    ok: false,
    errorCode: errorCode as AgentProcErrorCode,
    error: requireNonEmptyString(value.error, "error"),
  };
  if (value.jobs !== undefined) {
    if (!Array.isArray(value.jobs)) fail("invalid proc jobs");
    response.jobs = value.jobs.map(decodeAgentProcJob);
  }
  return response;
}
