import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentApiRoutes,
  decodeAgentProcErrorResponse,
  decodeAgentProcListResponse,
  decodeAgentProcLogsResponse,
  decodeAgentProcStartResponse,
  decodeAgentProcStopResponse,
} from "@lrm/coforge-sdk/agent";
import type {
  AgentControlResult,
  AgentStaleRuntimeStop,
  AgentStartIntent,
  AgentStopIntent,
  AgentWorkspaceDeleteRequest,
  RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import {
  DaemonRuntime,
  InMemoryDaemonCredentialStore,
  type DaemonConfig,
} from "@lrm/coforge-daemon";
import { startAgentProxy, type AgentProxy } from "#src/agent-proxy";
import { daemonAgentProxyRuntime } from "#src/agent-proxy-daemon-runtime";
import { operatorRunnerPorts } from "#src/daemon-runtime/operator-runner-identities";
import { sessionSpy } from "./fixtures/session-spy";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

const tempRoot = realpathSync(await mkdtemp(join(tmpdir(), "coforge-proxy-proc-")));
const cleanupPids = new Set<number>();

afterEach(() => {
  for (const pid of cleanupPids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  cleanupPids.clear();
});

afterAll(() => rm(tempRoot, { recursive: true, force: true }));

const piConfig: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

function proxyUrlFor(proxy: AgentProxy, path: string): string {
  return proxy.url.replace(agentApiRoutes.proxy.messages.path, path);
}

async function callProcStart(proxy: AgentProxy, token: string, name: string) {
  return fetch(proxyUrlFor(proxy, agentApiRoutes.proxy.proc.start.path), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name,
      command: [process.execPath, "-e", "console.log('proxy-ready'); setInterval(() => {}, 1000);"],
    }),
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function setupRuntimeFixture(
  options: { managed?: boolean; provider?: RuntimeProvider } = {},
) {
  const workspaceRoot = join(tempRoot, `wsroot-${crypto.randomUUID()}`);
  const stateDirectory = join(tempRoot, `state-${crypto.randomUUID()}`);
  const connection: DaemonConfig = {
    computerId: "computer-a",
    workspaceId: "workspace-a",
    workspaceRoot,
  };
  await mkdir(join(workspaceRoot, connection.workspaceId, "agents", "agent-a"), {
    recursive: true,
  });

  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");

  let onStartIntent: ((intent: AgentStartIntent) => void) | undefined;
  let onStopIntent: ((intent: AgentStopIntent) => void) | undefined;
  let onStaleStop: ((intent: AgentStaleRuntimeStop) => void) | undefined;
  let onDeleteWorkspace: ((req: AgentWorkspaceDeleteRequest) => Promise<void>) | undefined;
  let currentSessionId = "native-session-1";
  const controlWaiters = new Map<
    string,
    { resolve: () => void; targetPhases: ReadonlySet<string> }
  >();

  let runtime!: DaemonRuntime;
  const proxy = startAgentProxy({
    runtime: daemonAgentProxyRuntime(() => runtime),
  });

  runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: options.provider ?? "pi",
      createAgentSession: async () => ({
        ...sessionSpy(),
        readSessionIdentity: async () => ({ sessionId: currentSessionId, state: "resumable" }),
      }),
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentApiKey() {
          return `sk_agent_${"a".repeat(43)}`;
        },
        async revokeAgentApiKey() {},
        agentControlAccepted: () => true,
        async sendAgentControlResult(result: AgentControlResult) {
          const waiter = controlWaiters.get(result.requestId);
          if (waiter && waiter.targetPhases.has(result.phase)) {
            controlWaiters.delete(result.requestId);
            waiter.resolve();
          }
        },
        onAgentStart(handler) {
          onStartIntent = handler;
          return () => {};
        },
        onAgentStop(handler) {
          onStopIntent = handler;
          return () => {};
        },
        onAgentStaleRuntimeStop(handler) {
          onStaleStop = handler;
          return () => {};
        },
        onWorkspaceDelete(handler) {
          onDeleteWorkspace = handler;
          return () => {};
        },
      }),
    },
    proxy,
    emptyCodeAgentDiscovery,
    stateDirectory,
  );

  await runtime.start(connection);
  if (!options.managed) {
    await runtime.startAgent("agent-a", { ...piConfig, provider: options.provider ?? "pi" });
  }
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);

  const waitControl = (requestId: string, phases: readonly string[]) =>
    new Promise<void>((resolve) => {
      controlWaiters.set(requestId, { resolve, targetPhases: new Set(phases) });
    });

  return {
    runtime,
    proxy,
    token,
    connection,
    workspaceRoot,
    stateDirectory,
    setSessionId(next: string) {
      currentSessionId = next;
    },
    async triggerStart(intent: AgentStartIntent) {
      const done = waitControl(intent.requestId, ["started", "failed"]);
      onStartIntent?.(intent);
      await done;
    },
    async triggerStop(intent: AgentStopIntent) {
      const done = waitControl(intent.requestId, ["stopped", "failed"]);
      onStopIntent?.(intent);
      await done;
    },
    triggerStaleStop: (intent: AgentStaleRuntimeStop) => onStaleStop?.(intent),
    triggerDeleteWorkspace: (agentId: string) =>
      onDeleteWorkspace?.({
        protocolMajor: 1,
        requestId: `del-${crypto.randomUUID()}`,
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId,
      }),
  };
}

describe("agent-proxy proc routes and lifecycle hooks", () => {
  test("serves proc start, list, logs, stop, and domain error envelopes over AgentProxy", async () => {
    const fixture = await setupRuntimeFixture();
    try {
      const unauth = await fetch(proxyUrlFor(fixture.proxy, agentApiRoutes.proxy.proc.list.path));
      expect(unauth.status).toBe(401);

      const startRes = await callProcStart(fixture.proxy, fixture.token, "worker");
      expect(startRes.status).toBe(200);
      const started = decodeAgentProcStartResponse(await startRes.json());
      cleanupPids.add(started.job.pid);
      expect(started.job.name).toBe("worker");

      const dupRes = await callProcStart(fixture.proxy, fixture.token, "worker");
      expect(dupRes.status).toBe(409);
      const dupErr = decodeAgentProcErrorResponse(await dupRes.json());
      expect(dupErr.errorCode).toBe("proc_name_exists");

      const listRes = await fetch(proxyUrlFor(fixture.proxy, agentApiRoutes.proxy.proc.list.path), {
        headers: { authorization: `Bearer ${fixture.token}` },
      });
      expect(listRes.status).toBe(200);
      const listed = decodeAgentProcListResponse(await listRes.json());
      expect(listed.jobs.map((j) => j.name)).toEqual(["worker"]);

      let logPayload = decodeAgentProcLogsResponse(
        await (
          await fetch(
            `${proxyUrlFor(fixture.proxy, agentApiRoutes.proxy.proc.logs.path)}?name=worker&tail=20`,
            { headers: { authorization: `Bearer ${fixture.token}` } },
          )
        ).json(),
      );
      for (let i = 0; i < 40 && !logPayload.content.includes("proxy-ready"); i++) {
        await Bun.sleep(25);
        logPayload = decodeAgentProcLogsResponse(
          await (
            await fetch(
              `${proxyUrlFor(fixture.proxy, agentApiRoutes.proxy.proc.logs.path)}?name=worker&tail=20`,
              { headers: { authorization: `Bearer ${fixture.token}` } },
            )
          ).json(),
        );
      }
      expect(logPayload.content).toContain("proxy-ready");

      const missingRes = await fetch(
        `${proxyUrlFor(fixture.proxy, agentApiRoutes.proxy.proc.logs.path)}?name=ghost`,
        { headers: { authorization: `Bearer ${fixture.token}` } },
      );
      expect(missingRes.status).toBe(404);
      expect(decodeAgentProcErrorResponse(await missingRes.json()).errorCode).toBe(
        "proc_not_found",
      );

      const stopRes = await fetch(proxyUrlFor(fixture.proxy, agentApiRoutes.proxy.proc.stop.path), {
        method: "POST",
        headers: {
          authorization: `Bearer ${fixture.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "worker", force: true }),
      });
      expect(stopRes.status).toBe(200);
      const stopped = decodeAgentProcStopResponse(await stopRes.json());
      expect(stopped.stopped[0]?.stopReason).toBe("agent_stop");
    } finally {
      await fixture.runtime.stop();
      fixture.proxy.close();
    }
  });

  test("DaemonRuntime.stop() preserves running proc jobs for daemon restart adoption", async () => {
    const fixture = await setupRuntimeFixture();
    try {
      const startRes = await callProcStart(fixture.proxy, fixture.token, "survivor");
      const started = decodeAgentProcStartResponse(await startRes.json());
      cleanupPids.add(started.job.pid);

      await fixture.runtime.stop();
      fixture.proxy.close();
      expect(pidAlive(started.job.pid)).toBe(true);
    } finally {
      fixture.proxy.close();
    }
  });

  test("keeps proc jobs alive across session replacement while stopping them on owner stop, operator stop, and workspace delete", async () => {
    const fixture = await setupRuntimeFixture({ managed: true });
    try {
      await fixture.triggerStart({
        protocolMajor: 1,
        requestId: "start-1",
        workspaceId: fixture.connection.workspaceId,
        computerId: fixture.connection.computerId,
        agentId: "agent-a",
        provider: "pi",
        model: "default",
        modelProvider: "anthropic",
        reasoning: "balanced",
        controlEpoch: 1,
        launchId: "launch-1",
      });

      const token1 = fixture.proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
      const job = decodeAgentProcStartResponse(
        await (await callProcStart(fixture.proxy, token1, "srv")).json(),
      ).job;
      cleanupPids.add(job.pid);

      fixture.setSessionId("native-session-2");
      await fixture.triggerStart({
        protocolMajor: 1,
        requestId: "start-2",
        workspaceId: fixture.connection.workspaceId,
        computerId: fixture.connection.computerId,
        agentId: "agent-a",
        provider: "pi",
        model: "default",
        modelProvider: "anthropic",
        reasoning: "balanced",
        sessionId: "native-session-2",
        controlEpoch: 2,
        launchId: "launch-2",
      });
      expect(pidAlive(job.pid)).toBe(true);

      await fixture.triggerStop({
        protocolMajor: 1,
        requestId: "stop-1",
        workspaceId: fixture.connection.workspaceId,
        computerId: fixture.connection.computerId,
        agentId: "agent-a",
        provider: "pi",
        controlEpoch: 3,
      });
      expect(pidAlive(job.pid)).toBe(false);

      await fixture.triggerStart({
        protocolMajor: 1,
        requestId: "start-3",
        workspaceId: fixture.connection.workspaceId,
        computerId: fixture.connection.computerId,
        agentId: "agent-a",
        provider: "pi",
        model: "default",
        modelProvider: "anthropic",
        reasoning: "balanced",
        controlEpoch: 4,
        launchId: "launch-3",
      });
      const token2 = fixture.proxy.issue("agent-a", `sk_agent_${"b".repeat(43)}`);
      const job2 = decodeAgentProcStartResponse(
        await (await callProcStart(fixture.proxy, token2, "op-srv")).json(),
      ).job;
      cleanupPids.add(job2.pid);

      const operatorPorts = operatorRunnerPorts(
        () => fixture.runtime,
        () => fixture.connection.workspaceId,
      );
      await operatorPorts.stopAgent("agent-a");
      expect(pidAlive(job2.pid)).toBe(false);

      await fixture.triggerStart({
        protocolMajor: 1,
        requestId: "start-4",
        workspaceId: fixture.connection.workspaceId,
        computerId: fixture.connection.computerId,
        agentId: "agent-a",
        provider: "pi",
        model: "default",
        modelProvider: "anthropic",
        reasoning: "balanced",
        controlEpoch: 5,
        launchId: "launch-4",
      });
      const token3 = fixture.proxy.issue("agent-a", `sk_agent_${"c".repeat(43)}`);
      const job3 = decodeAgentProcStartResponse(
        await (await callProcStart(fixture.proxy, token3, "del-srv")).json(),
      ).job;
      cleanupPids.add(job3.pid);
      await fixture.runtime.stopAgent("agent-a");
      expect(pidAlive(job3.pid)).toBe(true);

      await fixture.triggerDeleteWorkspace("agent-a");
      expect(pidAlive(job3.pid)).toBe(false);
      expect(
        existsSync(
          join(fixture.workspaceRoot, fixture.connection.workspaceId, "agents", "agent-a"),
        ),
      ).toBe(false);
    } finally {
      await fixture.runtime.stop();
      fixture.proxy.close();
    }
  });

  test("staleRuntimeStop stops proc jobs even when no main session is running", async () => {
    const fixture = await setupRuntimeFixture({ managed: true });
    try {
      await fixture.triggerStart({
        protocolMajor: 1,
        requestId: "start-1",
        workspaceId: fixture.connection.workspaceId,
        computerId: fixture.connection.computerId,
        agentId: "agent-a",
        provider: "pi",
        model: "default",
        modelProvider: "anthropic",
        reasoning: "balanced",
        controlEpoch: 1,
        launchId: "launch-1",
      });
      const token = fixture.proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
      const job = decodeAgentProcStartResponse(
        await (await callProcStart(fixture.proxy, token, "stale-srv")).json(),
      ).job;
      cleanupPids.add(job.pid);

      await fixture.runtime.stopAgent("agent-a");
      expect(pidAlive(job.pid)).toBe(true);

      fixture.triggerStaleStop({
        protocolMajor: 1,
        requestId: "stale-1",
        workspaceId: fixture.connection.workspaceId,
        computerId: fixture.connection.computerId,
        agentId: "agent-a",
        controlEpoch: 9,
      });

      for (let i = 0; i < 60 && pidAlive(job.pid); i++) await Bun.sleep(50);
      expect(pidAlive(job.pid)).toBe(false);
    } finally {
      await fixture.runtime.stop();
      fixture.proxy.close();
    }
  });
});
