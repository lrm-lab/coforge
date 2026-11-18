import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionExit,
  AgentSessionOptions,
} from "@lrm/coforge-anvil";
import type { AgentActivity } from "@lrm/coforge-sdk/internal";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

class FakeSession {
  readonly #exitListeners = new Set<(exit?: AgentSessionExit) => void>();
  readonly #eventListeners = new Set<(event: AgentRuntimeEvent) => void>();

  async sendMessage() {}
  async interrupt() {}
  async dispose() {}
  subscribe(listener: (event: AgentRuntimeEvent) => void) {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }
  onExit(listener: (exit?: AgentSessionExit) => void) {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }
  emit(event: AgentRuntimeEvent) {
    for (const listener of this.#eventListeners) listener(event);
  }
  crash(exit?: AgentSessionExit) {
    for (const listener of this.#exitListeners) listener(exit);
  }
}

const config = {
  provider: "pi" as const,
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "coforge-exit-streak-"));
  const connection = {
    computerId: "computer-exit-streak",
    workspaceId: "workspace-exit-streak",
    workspaceRoot: root,
  };
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const activities: AgentActivity[] = [];
  const statuses: string[] = [];
  const acknowledgements: string[] = [];
  const rejections: unknown[] = [];
  const invalidates: Array<Record<string, unknown>> = [];
  const launches: Array<{ sessionId?: string; sessionMode?: string }> = [];
  const sessions: FakeSession[] = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession(options: AgentSessionOptions) {
        launches.push({ sessionId: options.sessionId, sessionMode: options.sessionMode });
        const session = new FakeSession();
        sessions.push(session);
        return session as AgentSession;
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        sendAgentStatus(status: { status: string }) {
          statuses.push(status.status);
        },
        async sendAgentDeliveryAck(ack: { deliveryId: string }) {
          acknowledgements.push(ack.deliveryId);
        },
        async sendAgentDeliveryRejection(rejection: unknown) {
          rejections.push(rejection);
        },
        sendAgentActivity(activity: AgentActivity) {
          activities.push(activity);
        },
        sendSessionInvalidate(message: Record<string, unknown>) {
          invalidates.push(message);
        },
        async requestAgentLaunchConfig() {
          return { agentApiKey: `sk_agent_${"a".repeat(43)}` };
        },
        async revokeAgentApiKey() {},
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  await runtime.start(connection);
  return {
    runtime,
    sessions,
    launches,
    activities,
    statuses,
    acknowledgements,
    rejections,
    invalidates,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const crash = { code: 1, signal: null } as const;
const OFFLINE = "times in a row without producing any output";

type Harness = Awaited<ReturnType<typeof harness>>;

async function crashNext(h: Harness) {
  await h.runtime.startAgent("agent-a", config);
  h.sessions.at(-1)!.crash(crash);
  await settle();
}

const offlineActivities = (h: Harness) => h.activities.filter((a) => a.detail?.includes(OFFLINE));

const deliver = (h: Harness, sequence: number) =>
  h.runtime.handleAgentMessage({
    protocolMajor: 1,
    requestId: `request-${sequence}`,
    messageId: `message-${sequence}`,
    deliveryId: `delivery-${sequence}`,
    sequence,
    workspaceId: "workspace-exit-streak",
    conversationId: "conversation-a",
    agentId: "agent-a",
    body: `body-${sequence}`,
    method: "agent:v1:message:deliver",
    target: "@ada",
  });

test("the fifth exit shows one offline message, reports inactive, and a later message does not wake the Agent", async () => {
  const h = await harness();
  try {
    for (let exit = 0; exit < 5; exit += 1) await crashNext(h);
    expect(offlineActivities(h)).toHaveLength(1);
    expect(h.statuses.at(-1)).toBe("inactive");
    expect(h.invalidates).toHaveLength(0);
    const launched = h.launches.length;
    await deliver(h, 1);
    await deliver(h, 2);
    await settle();
    expect(h.launches).toHaveLength(launched);
    expect(h.acknowledgements).toEqual(["delivery-1", "delivery-2"]);
    expect(h.rejections).toEqual([]);
    expect(offlineActivities(h).length).toBeGreaterThanOrEqual(1);
  } finally {
    await h.runtime.stop();
    await h.cleanup();
  }
});

test("an exit after the Agent was already taken offline is not counted", async () => {
  const h = await harness();
  try {
    await h.runtime.startAgent("agent-a", config);
    const session = h.sessions.at(-1)!;
    for (let repeat = 0; repeat < 3; repeat += 1)
      session.emit({ type: "error", message: "the provider returned a body nobody can decode" });
    session.crash(crash);
    await settle();
    expect(offlineActivities(h)).toHaveLength(0);
    for (let exit = 0; exit < 4; exit += 1) await crashNext(h);
    expect(offlineActivities(h)).toHaveLength(0);
    await crashNext(h);
    expect(offlineActivities(h)).toHaveLength(1);
  } finally {
    await h.runtime.stop();
    await h.cleanup();
  }
});
