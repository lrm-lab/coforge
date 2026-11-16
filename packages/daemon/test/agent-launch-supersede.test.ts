import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import type { AgentRuntimeConfig, AgentSession } from "@lrm/coforge-anvil";
import type { DaemonConfig } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { AgentConfigRequestError } from "#src/connection/agent-config-request";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

/** A server Start that arrives while the daemon relaunches an Agent on its own (the Mac woke and
 * the stalled-recovery sweep restarted a turn) wins: the relaunch's launch-config request carries
 * the old scope, which the server refuses once it is `starting` under the new one. The Start must
 * end `started` under its own scope, never inherit the relaunch's failure, and the relaunch must
 * not tell the person the Agent failed. The fixtures follow `agent-wake-launch-id.test.ts`. */

const tempRoot = realpathSync(tmpdir());
const connection: DaemonConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: join(tempRoot, `coforge-launch-supersede-${crypto.randomUUID()}`),
};

afterAll(() => rm(connection.workspaceRoot, { recursive: true, force: true }));

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

type ConfigRequest = { requestId?: string; launchId?: string };

/** A launch-config request the server answers only when the test lets it: the server judges the
 * scope against the Start it holds at that moment, as `authorizeLaunch` does. */
function configServer() {
  let current = "launch-1";
  let held: { request: ConfigRequest; answer: () => void } | undefined;
  let heldAsked: () => void = () => {};
  const asked = new Promise<void>((resolve) => (heldAsked = resolve));
  let gateNext = false;
  const refusal = () =>
    new AgentConfigRequestError(
      "refused",
      403,
      "AGENT_LAUNCH_SUPERSEDED",
      "Agent launch config request failed (403): Stale Agent launch",
    );
  const decide = (request: ConfigRequest) => {
    if (request.launchId !== undefined && request.launchId !== current) throw refusal();
    return { agentApiKey: `sk_agent_${"a".repeat(43)}` };
  };
  return {
    /** The Start the server now holds as `starting`. */
    moveTo(launchId: string) {
      current = launchId;
    },
    /** Holds the next request (the self-initiated relaunch's) until `release`. */
    holdNext() {
      gateNext = true;
    },
    asked,
    release() {
      held?.answer();
    },
    async request(request: ConfigRequest) {
      if (!gateNext) return decide(request);
      gateNext = false;
      await new Promise<void>((resolve) => {
        held = { request, answer: resolve };
        heldAsked();
      });
      return decide(request);
    },
  };
}

async function harness() {
  const stateDirectory = join(tempRoot, `coforge-launch-supersede-state-${crypto.randomUUID()}`);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const server = configServer();
  let exitListeners = new Set<() => void>();
  let sessions = 0;
  const notices: string[] = [];
  const statuses: string[] = [];
  const activityKinds: string[] = [];
  const sessionReports: Array<{ startRequestId: string; launchId: string; sessionId?: string }> =
    [];
  /** The next control result the Computer sends waits here until the test lets it go. */
  let resultGate: Promise<void> | undefined;
  let releaseResult: () => void = () => {};
  const controlResults: Array<{
    phase: string;
    requestId: string;
    launchId?: string;
    epoch: number;
  }> = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession() {
        sessions++;
        exitListeners = new Set();
        return {
          async sendMessage() {},
          subscribe() {
            return () => undefined;
          },
          async interrupt() {},
          async dispose() {},
          readSessionIdentity: async () => ({
            sessionId: `session-${sessions}`,
            state: "resumable" as const,
          }),
          notify: async (text: string) => {
            notices.push(text);
          },
          onExit(listener: () => void) {
            exitListeners.add(listener);
            return () => exitListeners.delete(listener);
          },
        } satisfies AgentSession & { notify(text: string): Promise<void> };
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        requestAgentLaunchConfig: (request: ConfigRequest) => server.request(request),
        async revokeAgentApiKey() {},
        sendAgentStatus(status) {
          statuses.push(status.status);
        },
        sendAgentActivity(activity) {
          activityKinds.push(activity.detailKind);
        },
        async sendAgentControlResult(result) {
          const gate = resultGate;
          resultGate = undefined;
          await gate;
          controlResults.push({
            phase: result.phase,
            requestId: result.requestId,
            launchId: result.launchId,
            epoch: result.epoch,
          });
        },
        async reportAgentSession(report) {
          sessionReports.push({
            startRequestId: report.startRequestId,
            launchId: report.launchId,
            sessionId: report.sessionId,
          });
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    stateDirectory,
  );
  return {
    runtime,
    stateDirectory,
    server,
    sessionCount: () => sessions,
    exitProcess: () => {
      for (const listener of Array.from(exitListeners)) listener();
    },
    notices,
    statuses,
    activityKinds,
    sessionReports,
    controlResults,
    /** Holds the next control result, so the Start that sends it stays pending until `releaseResult`. */
    holdNextResult() {
      resultGate = new Promise<void>((resolve) => (releaseResult = resolve));
    },
    releaseResult: () => releaseResult(),
  };
}

function managedStart(
  agentId: string,
  requestId: string,
  epoch: number,
  launchId: string,
  extra: { resumePrompt?: string } = {},
) {
  return {
    protocolMajor: 1,
    requestId,
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId,
    ...config,
    controlEpoch: epoch,
    launchId,
    ...extra,
  };
}

function deliverMessage(runtime: DaemonRuntime, agentId: string): Promise<void> {
  return runtime.handleAgentMessage({
    protocolMajor: 1,
    requestId: "delivery-request",
    messageId: "delivery-message",
    deliveryId: "delivery-1",
    sequence: 1,
    workspaceId: connection.workspaceId,
    conversationId: "conversation-1",
    agentId,
    body: "wake me",
    method: "agent:v1:message:deliver",
    target: "@agent",
  });
}

/** Lets every microtask chain the Start started run to the point where it waits on I/O. */
const settleMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Brings the Agent up under epoch 1, ends its process and starts the daemon's own relaunch (a
 * Message wake) with its launch-config request held, then delivers the server's newer Start while
 * that relaunch is still in flight. Returns the Start's promise, boxed so awaiting this does not await the Start. */
async function startWhileRelaunching(
  h: Awaited<ReturnType<typeof harness>>,
  agentId: string,
  next: ReturnType<typeof managedStart>,
) {
  await h.runtime.start(connection);
  await h.runtime.handleAgentStart(managedStart(agentId, "start-1", 1, "launch-1"));
  h.exitProcess();
  h.statuses.length = 0;
  h.activityKinds.length = 0;
  h.server.holdNext();
  void deliverMessage(h.runtime, agentId).catch(() => {});
  await h.server.asked;
  h.server.moveTo(next.launchId);
  const start = h.runtime.handleAgentStart(next);
  await settleMicrotasks();
  return { start };
}

test("a Start that meets a self-initiated relaunch the server refuses launches under its own scope", async () => {
  const h = await harness();
  try {
    const { start } = await startWhileRelaunching(
      h,
      "supersede-a",
      managedStart("supersede-a", "start-2", 2, "launch-2"),
    );
    h.server.release();
    await start;

    // The refused relaunch never reached a process; the Start spawned the one that runs.
    expect(h.sessionCount()).toBe(2);
    expect(h.controlResults.filter((result) => result.phase === "failed")).toEqual([]);
    expect(h.controlResults.at(-1)).toMatchObject({
      phase: "started",
      requestId: "start-2",
      epoch: 2,
      launchId: "launch-2",
    });
    expect(h.runtime.agentProcessManager.serverLaunch("supersede-a")).toMatchObject({
      requestId: "start-2",
      controlEpoch: 2,
      launchId: "launch-2",
    });
    // The relaunch yielded: the person is told of no failure and the Agent is never `inactive`.
    expect(h.activityKinds).not.toContain("runtime_error");
    expect(h.statuses).not.toContain("inactive");
  } finally {
    await h.runtime.stop();
    await rm(h.stateDirectory, { recursive: true, force: true });
  }
});

test("a Start that meets a self-initiated relaunch that succeeds rebinds its process", async () => {
  const h = await harness();
  try {
    // The server granted the relaunch before it moved on, so the relaunch comes up.
    const { start } = await startWhileRelaunching(
      h,
      "supersede-b",
      managedStart("supersede-b", "start-2", 2, "launch-2", { resumePrompt: "carry on" }),
    );
    h.server.moveTo("launch-1");
    h.server.release();
    await start;

    // One process for the relaunch and the Start: the Start rebinds it, never spawns a third.
    expect(h.sessionCount()).toBe(2);
    expect(h.controlResults.filter((result) => result.phase === "failed")).toEqual([]);
    expect(h.controlResults.at(-1)).toMatchObject({
      phase: "started",
      requestId: "start-2",
      epoch: 2,
      launchId: "launch-2",
    });
    expect(h.runtime.agentProcessManager.serverLaunch("supersede-b")).toMatchObject({
      requestId: "start-2",
      controlEpoch: 2,
      launchId: "launch-2",
    });
    // The Session is re-reported under the Start's scope, handing over from the relaunch's.
    expect(h.sessionReports.at(-1)).toMatchObject({
      startRequestId: "start-2",
      launchId: "launch-2",
      sessionId: "session-2",
    });
    // The Start's own input reaches the process it rebound.
    expect(h.notices.join("\n")).toContain("carry on");
    expect(h.activityKinds).not.toContain("runtime_error");
    expect(h.statuses).not.toContain("inactive");
  } finally {
    await h.runtime.stop();
    await rm(h.stateDirectory, { recursive: true, force: true });
  }
});

test("a refused relaunch with no Start pending still tells the person the Agent failed", async () => {
  const h = await harness();
  try {
    await h.runtime.start(connection);
    await h.runtime.handleAgentStart(managedStart("supersede-c", "start-1", 1, "launch-1"));
    h.exitProcess();
    h.statuses.length = 0;
    h.activityKinds.length = 0;
    h.server.holdNext();
    const delivery = deliverMessage(h.runtime, "supersede-c").catch(() => {});
    await h.server.asked;
    h.server.moveTo("launch-2");
    h.server.release();
    await delivery;

    expect(h.activityKinds).toContain("runtime_error");
    expect(h.statuses).toContain("inactive");
  } finally {
    await h.runtime.stop();
    await rm(h.stateDirectory, { recursive: true, force: true });
  }
});

test("a refused relaunch still tells the person while a Start that never launches is pending", async () => {
  const h = await harness();
  try {
    await h.runtime.start(connection);
    await h.runtime.handleAgentStart(managedStart("supersede-d", "start-1", 1, "launch-1"));
    h.exitProcess();
    h.statuses.length = 0;
    h.activityKinds.length = 0;
    h.server.holdNext();
    const delivery = deliverMessage(h.runtime, "supersede-d").catch(() => {});
    await h.server.asked;
    h.server.moveTo("launch-2");
    // The server re-sends the Start the Agent already completed. It ends without a launch, and
    // stays pending until the Computer has sent its result.
    h.holdNextResult();
    const replay = h.runtime.handleAgentStart(
      managedStart("supersede-d", "start-1", 1, "launch-1"),
    );
    replay.catch(() => {});
    await settleMicrotasks();
    h.server.release();
    await settleMicrotasks();
    h.releaseResult();
    await Promise.all([delivery, replay.catch(() => {})]);

    expect(h.activityKinds).toContain("runtime_error");
    expect(h.statuses).toContain("inactive");
  } finally {
    await h.runtime.stop();
    await rm(h.stateDirectory, { recursive: true, force: true });
  }
});
