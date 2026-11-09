import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import type { AgentRuntimeConfig, AgentSession } from "@lrm/coforge-anvil";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { AgentRuntimeBackoffStore } from "#src/persistence/agent-runtime-backoff-store";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

/** A reset credit spent in a running Workspace Daemon ends the waits the limit caused beyond the
 * Agents that have a live session: a launch waiting on the quota, a wake held off by its
 * cooldown, and a backoff a restart restored for an Agent not yet relaunched. */

const tempRoot = realpathSync(tmpdir());
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: join(tempRoot, `coforge-limit-lift-${crypto.randomUUID()}`),
};
const config: AgentRuntimeConfig = {
  provider: "codex",
  model: "default",
  modelProvider: "openai",
  reasoning: "balanced",
};
const key = "0b8c1f3e-52d7-4a9c-9a4e-6f1d2c3b4a59";
const HOUR_MS = 60 * 60_000;
const QUOTA_REACHED = "You've reached your weekly usage limit. Resets in 3h (3:45pm).";

afterAll(() => rm(connection.workspaceRoot, { recursive: true, force: true }));

function liveSession(onExit: (listener: () => void) => () => void) {
  return {
    async sendMessage() {},
    async notify() {},
    subscribe() {
      return () => undefined;
    },
    async interrupt() {},
    onExit,
    async dispose() {},
  } satisfies AgentSession;
}

/** A runtime whose Codex launches follow `plan` (a launch beyond the plan succeeds), whose
 * processes exit on demand, and whose reset credit attempt answers `reset`. */
async function harness(plan: Array<"ok" | "quota">, stateDirectory: string) {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  let exitListeners = new Set<() => void>();
  let launches = 0;
  const launched: Array<PromiseWithResolvers<void>> = [];
  const controlResults: Array<{ phase: string }> = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "codex",
      async createAgentSession() {
        const attempt = launches++;
        launched[attempt]?.resolve();
        if (plan[attempt] === "quota") throw new Error(QUOTA_REACHED);
        exitListeners = new Set();
        return liveSession((listener) => {
          exitListeners.add(listener);
          return () => exitListeners.delete(listener);
        });
      },
      consumeResetCredit: async () => "reset" as const,
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentLaunchConfig() {
          return { agentApiKey: `sk_agent_${"a".repeat(43)}` };
        },
        async revokeAgentApiKey() {},
        async sendAgentDeliveryAck() {},
        sendAgentActivity() {},
        async sendAgentControlResult(result) {
          controlResults.push({ phase: result.phase });
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    stateDirectory,
  );
  return {
    runtime,
    controlResults,
    launches: () => launches,
    /** Settles when launch number `attempt` (counting from 0) reaches the provider. */
    launchReached: (attempt: number) => {
      launched[attempt] ??= Promise.withResolvers<void>();
      if (launches > attempt) launched[attempt].resolve();
      return launched[attempt].promise;
    },
    exitProcess: () => {
      for (const listener of Array.from(exitListeners)) listener();
    },
    deliver: (deliveryId: string) =>
      runtime
        .handleAgentMessage({
          protocolMajor: 1,
          requestId: `${deliveryId}-request`,
          messageId: `${deliveryId}-message`,
          deliveryId,
          sequence: 1,
          workspaceId: connection.workspaceId,
          conversationId: "conversation-1",
          agentId: "agent-a",
          body: "wake me",
          method: "agent:v1:message:deliver",
          target: "@ada",
        })
        .catch(() => {}),
  };
}

const managedStart = {
  protocolMajor: 1,
  requestId: "start-1",
  workspaceId: connection.workspaceId,
  computerId: connection.computerId,
  agentId: "agent-a",
  ...config,
  controlEpoch: 1,
  launchId: "launch-1",
};

async function withState(run: (stateDirectory: string) => Promise<void>) {
  const stateDirectory = await mkdtemp(join(tempRoot, "coforge-limit-lift-state-"));
  try {
    await run(stateDirectory);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

test("a reset starts an Agent whose launch waits on the quota instead of waiting for its reset time", async () =>
  withState(async (stateDirectory) => {
    const h = await harness(["quota", "ok"], stateDirectory);
    try {
      await h.runtime.start(connection);
      // The Start is still pending, which `handleAgentStart` reports as an incomplete launch.
      await h.runtime.handleAgentStart(managedStart).catch(() => {});
      expect(h.launches()).toBe(1);
      expect(h.controlResults).toEqual([]);
      const second = h.launchReached(1);

      expect((await h.runtime.consumeResetCredit("codex", key)).outcome).toBe("reset");

      await second;
      expect(h.launches()).toBe(2);
    } finally {
      await h.runtime.stop();
    }
  }));

test("a reset lets the next message wake an Agent whose wake was held off by the quota", async () =>
  withState(async (stateDirectory) => {
    const h = await harness(["ok", "quota", "ok"], stateDirectory);
    try {
      await h.runtime.start(connection);
      await h.runtime.handleAgentStart(managedStart);
      h.exitProcess();
      await h.deliver("delivery-1");
      expect(h.launches()).toBe(2);
      await h.deliver("delivery-2");
      // The cooldown from the quota reset time defers this wake.
      expect(h.launches()).toBe(2);

      expect((await h.runtime.consumeResetCredit("codex", key)).outcome).toBe("reset");
      await h.deliver("delivery-3");

      expect(h.launches()).toBe(3);
    } finally {
      await h.runtime.stop();
    }
  }));

test("a reset ends the backoff a restart restored for this provider's Agent that is not relaunched", async () =>
  withState(async (stateDirectory) => {
    const previous = new AgentRuntimeBackoffStore(() => stateDirectory, "previous-process");
    const untilMs = Date.now() + HOUR_MS;
    previous.save("agent-a", { untilMs, reason: "rate_limit_backoff", provider: "codex" });
    previous.save("agent-b", { untilMs, reason: "rate_limit_backoff", provider: "claude-code" });
    previous.save("agent-c", { untilMs, reason: "rate_limit_backoff" });
    const h = await harness([], stateDirectory);
    try {
      await h.runtime.start(connection);

      expect((await h.runtime.consumeResetCredit("codex", key)).outcome).toBe("reset");

      // Records the next process would restore: only the ones still waiting remain.
      const remaining = new AgentRuntimeBackoffStore(() => stateDirectory, "inspector").list();
      expect(remaining.map((record) => record.agentId).sort()).toEqual(["agent-b", "agent-c"]);
    } finally {
      await h.runtime.stop();
    }
  }));
