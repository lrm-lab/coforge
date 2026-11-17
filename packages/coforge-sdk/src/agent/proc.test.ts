import { describe, expect, test } from "bun:test";
import {
  PROC_CAPABILITY,
  PROC_EXITED_KEPT_PER_AGENT,
  PROC_JOB_LEDGER_FILE,
  PROC_LOG_MAX_BYTES,
  PROC_LOGS_DEFAULT_TAIL,
  PROC_LOGS_FOLLOW_MAX_MS,
  PROC_LOGS_MAX_TAIL,
  PROC_MAX_JOBS_PER_AGENT,
  PROC_NAME_MAX_LENGTH,
  PROC_NAME_PATTERN,
  PROC_START_MAX_BODY_BYTES,
  agentApiRoutes,
  buildCoforgeCliGuideSections,
  buildExternalAgentGuide,
  decodeAgentProcErrorResponse,
  decodeAgentProcJob,
  decodeAgentProcListResponse,
  decodeAgentProcLogsRequest,
  decodeAgentProcLogsResponse,
  decodeAgentProcStartRequest,
  decodeAgentProcStartResponse,
  decodeAgentProcStopRequest,
  decodeAgentProcStopResponse,
  type AgentProcJob,
} from "./index";

const sampleJob: AgentProcJob = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "dev-server",
  command: ["bun", "run", "dev"],
  cwd: "/tmp/workspace/agent-1",
  pid: 43210,
  pgid: 43210,
  status: "running",
  startedAt: "2026-11-17T10:00:00.000Z",
  logPath: "/tmp/workspace/agent-1/proc-logs/dev-server.log",
};

describe("agent proc contracts", () => {
  test("exports expected proc constants", () => {
    expect(PROC_CAPABILITY).toBe("proc:v1");
    expect(PROC_NAME_MAX_LENGTH).toBe(40);
    expect(PROC_NAME_PATTERN.test("api_1-dev")).toBe(true);
    expect(PROC_NAME_PATTERN.test("../escape")).toBe(false);
    expect(PROC_NAME_PATTERN.test("a".repeat(41))).toBe(false);
    expect(PROC_MAX_JOBS_PER_AGENT).toBe(8);
    expect(PROC_EXITED_KEPT_PER_AGENT).toBe(8);
    expect(PROC_LOG_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(PROC_LOGS_DEFAULT_TAIL).toBe(50);
    expect(PROC_LOGS_MAX_TAIL).toBe(2_000);
    expect(PROC_LOGS_FOLLOW_MAX_MS).toBe(30_000);
    expect(PROC_START_MAX_BODY_BYTES).toBe(256 * 1024);
    expect(PROC_JOB_LEDGER_FILE).toBe("proc-jobs.json");
  });

  test("decodes valid jobs and rejects malformed job fields", () => {
    expect(decodeAgentProcJob(sampleJob)).toEqual(sampleJob);
    const exited: AgentProcJob = {
      ...sampleJob,
      status: "exited",
      systemdUnit: "coforge-proc-agent1-dev-server.service",
      stopsWithService: true,
      exitedAt: "2026-11-17T10:05:00.000Z",
      exitCode: 0,
      signal: null,
      stopReason: "agent_stop",
    };
    expect(decodeAgentProcJob(exited)).toEqual(exited);

    expect(() => decodeAgentProcJob(null)).toThrow();
    expect(() => decodeAgentProcJob({ ...sampleJob, name: "bad/name" })).toThrow();
    expect(() => decodeAgentProcJob({ ...sampleJob, command: [] })).toThrow();
    expect(() => decodeAgentProcJob({ ...sampleJob, pid: 0 })).toThrow();
    expect(() => decodeAgentProcJob({ ...sampleJob, status: "paused" })).toThrow();
    expect(() => decodeAgentProcJob({ ...sampleJob, stopReason: "unknown" })).toThrow();
  });

  test("decodes start request and enforces name, command, cwd, and env constraints", () => {
    expect(
      decodeAgentProcStartRequest({
        command: ["node", "server.js"],
        name: "api_1",
        cwd: "apps/api",
        env: { PORT: "3000" },
      }),
    ).toEqual({
      command: ["node", "server.js"],
      name: "api_1",
      cwd: "apps/api",
      env: { PORT: "3000" },
    });
    expect(() => decodeAgentProcStartRequest({ command: [] })).toThrow();
    expect(() => decodeAgentProcStartRequest({ command: ["ok"], name: "" })).toThrow();
    expect(() => decodeAgentProcStartRequest({ command: ["ok"], name: "bad name" })).toThrow();
    expect(() => decodeAgentProcStartRequest({ command: ["ok"], env: { PORT: 3000 } })).toThrow();
    expect(() =>
      decodeAgentProcStartRequest({ command: ["ok"], env: { "BAD=KEY": "1" } }),
    ).toThrow();
  });

  test("decodes list, start, logs, stop, and error payloads", () => {
    expect(decodeAgentProcListResponse({ ok: true, jobs: [sampleJob], limit: 8 })).toEqual({
      ok: true,
      jobs: [sampleJob],
      limit: 8,
    });
    expect(
      decodeAgentProcStartResponse({ ok: true, job: sampleJob, replacedExited: true }),
    ).toEqual({ ok: true, job: sampleJob, replacedExited: true });
    expect(decodeAgentProcLogsRequest({ name: "dev-server", tail: 100, offset: 0 })).toEqual({
      name: "dev-server",
      tail: 100,
      offset: 0,
    });
    expect(() => decodeAgentProcLogsRequest({ name: "dev-server", tail: 2001 })).toThrow();
    expect(() => decodeAgentProcLogsRequest({ name: "dev-server", offset: -1 })).toThrow();

    expect(
      decodeAgentProcLogsResponse({
        ok: true,
        job: sampleJob,
        content: "listening\n",
        nextOffset: 10,
        rotated: false,
        truncated: false,
      }),
    ).toEqual({
      ok: true,
      job: sampleJob,
      content: "listening\n",
      nextOffset: 10,
      rotated: false,
      truncated: false,
    });

    expect(decodeAgentProcStopRequest({ name: "dev-server", force: true })).toEqual({
      name: "dev-server",
      force: true,
    });
    expect(decodeAgentProcStopRequest({ all: true })).toEqual({ all: true });
    expect(() => decodeAgentProcStopRequest({})).toThrow();
    expect(() => decodeAgentProcStopRequest({ name: "dev-server", all: true })).toThrow();

    expect(
      decodeAgentProcStopResponse({
        ok: true,
        stopped: [sampleJob],
        alreadyExited: ["old-worker"],
      }),
    ).toEqual({
      ok: true,
      stopped: [sampleJob],
      alreadyExited: ["old-worker"],
    });

    expect(
      decodeAgentProcErrorResponse({
        ok: false,
        errorCode: "proc_limit",
        error: "maximum of 8 running jobs reached",
        jobs: [sampleJob],
      }),
    ).toEqual({
      ok: false,
      errorCode: "proc_limit",
      error: "maximum of 8 running jobs reached",
      jobs: [sampleJob],
    });
    expect(
      decodeAgentProcErrorResponse({
        ok: false,
        errorCode: "proc_stop_failed",
        error: "job did not exit",
      }),
    ).toEqual({
      ok: false,
      errorCode: "proc_stop_failed",
      error: "job did not exit",
    });
    expect(() =>
      decodeAgentProcErrorResponse({ ok: false, errorCode: "not_a_proc_code", error: "bad" }),
    ).toThrow();
  });

  test("exposes proc routes under proxy and local, not cloud", () => {
    const expected = {
      list: { method: "GET", path: "/api/agent/v1/proc" },
      logs: { method: "GET", path: "/api/agent/v1/proc/logs" },
      start: {
        method: "POST",
        path: "/api/agent/v1/proc/start",
        maxBodyBytes: PROC_START_MAX_BODY_BYTES,
      },
      stop: { method: "POST", path: "/api/agent/v1/proc/stop" },
    } as const;
    expect(agentApiRoutes.proxy.proc).toEqual(expected);
    expect(agentApiRoutes.local.proc).toEqual(expected);
    expect("proc" in agentApiRoutes.cloud).toBe(false);
  });

  test("teaches managed agents coforge proc while marking it unavailable to external agents", () => {
    const managed = buildCoforgeCliGuideSections({ audience: "managed" });
    expect(managed.execution).toContain("coforge proc start|list|logs|stop");

    const externalSections = buildCoforgeCliGuideSections({ audience: "external" });
    expect(Object.values(externalSections).join("\n")).not.toContain("coforge proc");

    const externalGuide = buildExternalAgentGuide({
      agent: {
        id: "agent-1",
        name: "alice",
        displayName: "Alice",
        description: "Helper",
        role: "member",
      },
      workspace: { id: "ws-1", slug: "lrm-lab", name: "LRM Lab" },
    });
    expect(externalGuide).toContain("`coforge proc`");
  });
});
