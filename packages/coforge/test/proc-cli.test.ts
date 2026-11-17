import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentProcJob,
  type AgentProcLogsRequest,
  type AgentProcStartRequest,
} from "@lrm/coforge-sdk/agent";
import { parseArgs, run, type MessageTransport } from "../index";
import { CliError } from "#src/cli-error";
import { commandHelp } from "#src/command-help/index";
import { connectExternal } from "#src/external/direct-transport";
import { profileStore } from "#src/external/profile-store";
import { UNSUPPORTED_CODE } from "#src/external/refusal";
import { procRequests } from "#src/proc-request";
import { proxyEndpointOf } from "#src/proxy-request";
import { CLI_USAGE, cliUsage } from "#src/usage";

const tempDirs: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const runningJob: AgentProcJob = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "dev-srv",
  command: ["bun", "run", "dev", "--help"],
  cwd: "/tmp/ws/agent-a",
  pid: 9012,
  pgid: 9012,
  status: "running",
  startedAt: "2026-11-17T10:00:00.000Z",
  logPath: "/tmp/ws/agent-a/proc-logs/dev-srv.log",
};

describe("coforge proc CLI", () => {
  test("parses start, list, logs, and stop arguments while preserving child flags after --", () => {
    expect(
      parseArgs([
        "proc",
        "start",
        "--name",
        "dev-srv",
        "--cwd",
        "apps/web",
        "--env",
        "PORT=3000",
        "--env",
        "EMPTY=",
        "--json",
        "--",
        "bun",
        "run",
        "dev",
        "--help",
        "--json",
      ]),
    ).toEqual({
      command: "proc",
      operation: "start",
      name: "dev-srv",
      cwd: "apps/web",
      env: { PORT: "3000", EMPTY: "" },
      commandArgs: ["bun", "run", "dev", "--help", "--json"],
      json: true,
    });

    expect(parseArgs(["proc", "start", "node", "server.js"])).toEqual({
      command: "proc",
      operation: "start",
      commandArgs: ["node", "server.js"],
    });

    expect(parseArgs(["proc", "list", "--json"])).toEqual({
      command: "proc",
      operation: "list",
      json: true,
    });

    expect(parseArgs(["proc", "logs", "dev-srv", "--tail", "25", "--follow"])).toEqual({
      command: "proc",
      operation: "logs",
      name: "dev-srv",
      tail: 25,
      follow: true,
    });

    expect(parseArgs(["proc", "stop", "dev-srv", "--force"])).toEqual({
      command: "proc",
      operation: "stop",
      name: "dev-srv",
      force: true,
    });

    expect(parseArgs(["proc", "stop", "--all", "--json"])).toEqual({
      command: "proc",
      operation: "stop",
      all: true,
      json: true,
    });

    expect(() => parseArgs(["proc", "stop", "dev-srv", "--all"])).toThrow();
    expect(() => parseArgs(["proc", "stop"])).toThrow();
    expect(() => parseArgs(["proc", "logs"])).toThrow();
    expect(() => parseArgs(["proc", "start", "--env", "NO_EQUALS", "node"])).toThrow();
  });

  test("passes child --help past -- to procStart instead of rendering CLI help", async () => {
    let seenCommand: string[] = [];
    const transport = {
      procStart: async (request: AgentProcStartRequest) => {
        seenCommand = request.command;
        return { ok: true as const, job: runningJob };
      },
    } as unknown as MessageTransport;

    const output = (await run(
      ["proc", "start", "--name", "dev-srv", "--", "bun", "run", "dev", "--help"],
      transport,
    )) as string;
    expect(seenCommand).toEqual(["bun", "run", "dev", "--help"]);
    expect(output).toContain("Started background job dev-srv");
    expect(output).toContain("pid 9012");
  });

  test("formats list, logs (--follow incremental offsets), and stop output", async () => {
    const logCalls: Array<{ name: string; tail?: number; offset?: number }> = [];
    const exitedJob: AgentProcJob = {
      ...runningJob,
      status: "exited",
      exitedAt: "2026-11-17T10:01:00.000Z",
      exitCode: 0,
      signal: null,
      stopReason: "exited",
    };

    const transport = {
      procList: async () => ({ ok: true as const, jobs: [runningJob], limit: 8 }),
      procLogs: async (req: AgentProcLogsRequest) => {
        logCalls.push(req);
        if (logCalls.length === 1) {
          return {
            ok: true as const,
            job: runningJob,
            content: "booting\n",
            nextOffset: 8,
            rotated: false,
            truncated: false,
          };
        }
        return {
          ok: true as const,
          job: exitedJob,
          content: "done\n",
          nextOffset: 13,
          rotated: false,
          truncated: false,
        };
      },
      procStop: async () => ({ ok: true as const, stopped: [exitedJob], alreadyExited: [] }),
    } as unknown as MessageTransport;

    const listed = (await run(["proc", "list"], transport)) as string;
    expect(listed).toContain("dev-srv");
    expect(listed).toContain("running");

    const followed = (await run(
      ["proc", "logs", "dev-srv", "--tail", "10", "--follow"],
      transport,
    )) as string;
    expect(logCalls).toEqual([
      { name: "dev-srv", tail: 10 },
      { name: "dev-srv", offset: 8 },
    ]);
    expect(followed).toBe("booting\ndone\n");

    const stopped = (await run(["proc", "stop", "dev-srv", "--json"], transport)) as string;
    expect(JSON.parse(stopped)).toEqual({
      ok: true,
      stopped: [exitedJob],
      alreadyExited: [],
    });
  });

  test("registers proc usage and command help entries", async () => {
    expect(CLI_USAGE).toContain("coforge proc start|list|logs|stop");
    expect(cliUsage()).toContain("coforge proc start|list|logs|stop");
    expect(commandHelp([])).toContain("  proc");
    for (const args of [
      ["proc", "--help"],
      ["proc", "start", "--help"],
      ["proc", "list", "--help"],
      ["proc", "logs", "--help"],
      ["proc", "stop", "--help"],
    ]) {
      const help = commandHelp(args);
      expect(help).toBeDefined();
      expect(help).toContain("coforge proc");
    }
  });

  test("procRequests sends HTTP requests and converts proc_limit into actionable CliError", async () => {
    let seenMethod = "";
    let seenPath = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        seenMethod = request.method;
        seenPath = url.pathname + url.search;
        if (url.pathname === "/api/agent/v1/proc") {
          return Response.json({ ok: true, jobs: [runningJob], limit: 8 });
        }
        if (url.pathname === "/api/agent/v1/proc/start") {
          return Response.json(
            {
              ok: false,
              errorCode: "proc_limit",
              error: "Maximum of 8 running background jobs reached.",
              jobs: [runningJob],
            },
            { status: 409 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    const proxyUrl = `http://127.0.0.1:${server.port}/api/agent/v1/messages`;
    const context = `sfp_${"a".repeat(43)}`;
    const client = procRequests(proxyEndpointOf(proxyUrl), context, proxyUrl);

    const listed = await client.procList();
    expect(seenMethod).toBe("GET");
    expect(seenPath).toBe("/api/agent/v1/proc");
    expect(listed.jobs).toEqual([runningJob]);

    const err = (await client
      .procStart({ command: ["node"] })
      .catch((error: unknown) => error)) as CliError;
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe("PROC_LIMIT");
    expect(err.suggestedNextAction).toContain("dev-srv");
    expect(err.suggestedNextAction).toContain("coforge proc stop");
  });

  test("external agent transport refuses coforge proc commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coforge-proc-ext-"));
    tempDirs.push(dir);
    const store = profileStore({ COFORGE_AGENT_HOME: dir });
    const { transport } = connectExternal(
      {
        slug: "test-profile",
        path: store.pathOf("test-profile"),
        profile: {
          schemaVersion: 1,
          serverUrl: "https://example.invalid",
          agentId: "agent-1",
          agentName: "alice",
          workspaceId: "ws-1",
          workspaceSlug: "ws",
          credentialId: "cred-1",
          apiKey: `sk_ext_${"a".repeat(43)}`,
          createdAt: new Date().toISOString(),
        },
      },
      store,
    );
    await expect(run(["proc", "list"], transport)).rejects.toMatchObject({
      code: UNSUPPORTED_CODE,
    });
  });

  test("preserves json outputMode when proc transport rejects with a CliError", async () => {
    const transport = {
      procStart: async () => {
        throw new CliError({
          code: "PROC_LIMIT",
          message: "Maximum of 8 running background jobs reached.",
          retryable: false,
          details: { jobs: [runningJob] },
        });
      },
      procList: async () => {
        throw new CliError({
          code: "UNSUPPORTED_FOR_EXTERNAL_AGENTS",
          message: "Not available to external Agents.",
          retryable: false,
        });
      },
    } as unknown as MessageTransport;

    const startErr = (await run(["proc", "start", "--json", "--", "node"], transport).catch(
      (err: unknown) => err,
    )) as CliError;
    expect(startErr).toBeInstanceOf(CliError);
    expect(startErr.outputMode).toBe("json");
    expect(startErr.details).toEqual({ jobs: [runningJob] });

    const listErr = (await run(["proc", "list", "--json"], transport).catch(
      (err: unknown) => err,
    )) as CliError;
    expect(listErr).toBeInstanceOf(CliError);
    expect(listErr.outputMode).toBe("json");

    for (const args of [
      ["proc", "start", "--json", "--name"],
      ["proc", "start", "--json", "--cwd"],
      ["proc", "start", "--json", "--env"],
      ["proc", "logs", "dev-srv", "--json", "--tail"],
    ]) {
      const parseErr = (await run(args, transport).catch((err: unknown) => err)) as CliError;
      expect(parseErr).toBeInstanceOf(CliError);
      expect(parseErr.code).toBe("INVALID_ARG");
      expect(parseErr.outputMode).toBe("json");
    }
  });
});
