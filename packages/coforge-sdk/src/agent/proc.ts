import { z } from "zod";

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

const plainStringSchema = z.string().refine((value) => !value.includes("\0"));
const nonEmptyStringSchema = plainStringSchema.refine((value) => value.trim().length > 0);
const jobNameSchema = nonEmptyStringSchema.regex(PROC_NAME_PATTERN);
const positiveSafeIntSchema = z.int().min(1);
const nonNegativeSafeIntSchema = z.int().min(0);
const commandArraySchema = z
  .array(plainStringSchema)
  .min(1)
  .refine((command) => command[0]!.trim().length > 0);

const procMemorySchema = z.object({
  mode: z.enum(["process_group_rss", "systemd_cgroup"]),
  limitBytes: positiveSafeIntSchema,
  usageBytes: nonNegativeSafeIntSchema.optional(),
  termination: z.literal("memory_limit").optional(),
});

const procJobSchema = z
  .object({
    id: nonEmptyStringSchema,
    name: jobNameSchema,
    command: commandArraySchema,
    cwd: nonEmptyStringSchema,
    pid: positiveSafeIntSchema,
    pgid: positiveSafeIntSchema.nullable(),
    systemdUnit: nonEmptyStringSchema.optional(),
    stopsWithService: z.boolean().optional(),
    status: z.enum(AGENT_PROC_JOB_STATUSES),
    startedAt: nonEmptyStringSchema,
    exitedAt: nonEmptyStringSchema.optional(),
    exitCode: z.int().nullable().optional(),
    signal: nonEmptyStringSchema.nullable().optional(),
    stopReason: z.enum(AGENT_PROC_STOP_REASONS).optional(),
    memory: procMemorySchema.optional(),
    logPath: nonEmptyStringSchema,
  })
  .refine(
    (job) => job.memory?.termination === undefined || job.status === "exited",
    "invalid proc memory termination",
  );

const procListResponseSchema = z.object({
  ok: z.literal(true),
  jobs: z.array(procJobSchema),
  limit: positiveSafeIntSchema,
});

const procEnvSchema = z
  .record(z.string(), plainStringSchema)
  .refine((env) =>
    Object.keys(env).every((key) => key.length > 0 && !key.includes("=") && !key.includes("\0")),
  );

const procStartRequestSchema = z.strictObject({
  command: commandArraySchema,
  name: jobNameSchema.optional(),
  cwd: nonEmptyStringSchema.optional(),
  env: procEnvSchema.optional(),
});

const procStartResponseSchema = z.object({
  ok: z.literal(true),
  job: procJobSchema,
  replacedExited: z.boolean().optional(),
});

const procLogsRequestSchema = z.strictObject({
  name: jobNameSchema,
  tail: nonNegativeSafeIntSchema.max(PROC_LOGS_MAX_TAIL).optional(),
  offset: nonNegativeSafeIntSchema.optional(),
});

const procLogsResponseSchema = z.object({
  ok: z.literal(true),
  job: procJobSchema,
  content: plainStringSchema,
  nextOffset: nonNegativeSafeIntSchema,
  rotated: z.boolean(),
  truncated: z.boolean(),
});

const procStopRequestSchema = z
  .strictObject({
    name: jobNameSchema.optional(),
    all: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .refine(
    (request) => (request.name !== undefined) !== (request.all === true),
    "proc stop requires either name or all=true",
  );

const procStopResponseSchema = z.object({
  ok: z.literal(true),
  stopped: z.array(procJobSchema),
  alreadyExited: z.array(jobNameSchema),
});

const procErrorResponseSchema = z.object({
  ok: z.literal(false),
  errorCode: z.enum(AGENT_PROC_ERROR_CODES),
  error: nonEmptyStringSchema,
  jobs: z.array(procJobSchema).optional(),
});

function parseProc<T>(schema: z.ZodType<T>, value: unknown, fallbackMessage: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const custom = parsed.error.issues.find(
      (issue) => issue.code === "custom" && issue.message !== "Invalid input",
    );
    throw new Error(custom?.message || fallbackMessage);
  }
  return parsed.data;
}

export function decodeAgentProcJob(value: unknown): AgentProcJob {
  return parseProc(procJobSchema, value, "invalid proc job");
}

export function decodeAgentProcListResponse(value: unknown): AgentProcListResponse {
  return parseProc(procListResponseSchema, value, "invalid proc list response");
}

export function decodeAgentProcStartRequest(value: unknown): AgentProcStartRequest {
  return parseProc(procStartRequestSchema, value, "invalid proc start request");
}

export function decodeAgentProcStartResponse(value: unknown): AgentProcStartResponse {
  return parseProc(procStartResponseSchema, value, "invalid proc start response");
}

export function decodeAgentProcLogsRequest(value: unknown): AgentProcLogsRequest {
  return parseProc(procLogsRequestSchema, value, "invalid proc logs request");
}

export function decodeAgentProcLogsResponse(value: unknown): AgentProcLogsResponse {
  return parseProc(procLogsResponseSchema, value, "invalid proc logs response");
}

export function decodeAgentProcStopRequest(value: unknown): AgentProcStopRequest {
  return parseProc(procStopRequestSchema, value, "invalid proc stop request");
}

export function decodeAgentProcStopResponse(value: unknown): AgentProcStopResponse {
  return parseProc(procStopResponseSchema, value, "invalid proc stop response");
}

export function decodeAgentProcErrorResponse(value: unknown): AgentProcErrorResponse {
  return parseProc(procErrorResponseSchema, value, "invalid proc error response");
}
