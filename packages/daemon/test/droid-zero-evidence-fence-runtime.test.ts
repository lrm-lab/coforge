import { afterEach, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig, AgentRuntimeEvent, AgentSession } from "@lrm/coforge-anvil";
import type { AgentActivity } from "@lrm/coforge-sdk/internal";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime, type DaemonConfig } from "#src/daemon-runtime/runtime";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

afterEach(() => jest.useRealTimers());

test("five empty turns in a row end with the Agent fenced instead of restarted again", async () => {
  const connection: DaemonConfig = {
    computerId: "computer-a",
    workspaceId: "workspace-a",
    workspaceRoot: mkdtempSync(join(tmpdir(), "coforge-five-")),
  };
  const config: AgentRuntimeConfig = {
    provider: "droid",
    model: "default",
    modelProvider: "anthropic",
    reasoning: "balanced",
  };
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const activities: AgentActivity[] = [];
  const waiters: Array<() => void> = [];
  let sessions = 0;
  let notices = 0;
  const session = {
    hasLiveTurn: false,
    async sendMessage() {},
    async notify() {
      notices += 1;
      waiters.shift()?.();
    },
    subscribe(listener: (event: AgentRuntimeEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async interrupt() {},
    onExit() {
      return () => undefined;
    },
    async dispose() {},
  } satisfies AgentSession;
  const endTurn = () => {
    for (const listener of listeners) listener({ type: "completed", status: "completed" });
  };
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const state = mkdtempSync(join(tmpdir(), "coforge-five-state-"));
  const runtime = new DaemonRuntime(
    connection,
    () => {
      sessions += 1;
      return { provider: "droid", createAgentSession: async () => session };
    },
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
        async sendAgentDeliveryAck() {},
        sendAgentActivity(activity) {
          activities.push(activity);
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    state,
  );
  const count = (reason: string) =>
    activities.filter((activity) => activity.runtimeError?.errorReason === reason).length;
  const deliver = (sequence: number) =>
    runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: `request-${sequence}`,
      messageId: `message-${sequence}`,
      deliveryId: `delivery-${sequence}`,
      sequence,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-a",
      agentId: "agent-a",
      body: `body-${sequence}`,
      method: "agent:v1:message:deliver",
      target: "@ada",
    });
  await runtime.start(connection);
  await runtime.startAgent("agent-a", config);
  jest.useFakeTimers();
  try {
    endTurn();
    expect(count("zero_evidence_turn_completed")).toBe(1);
    expect(count("runtime_error_fenced")).toBe(0);
    for (let round = 2; round <= 5; round += 1) {
      const noticed = new Promise<void>((resolve) => waiters.push(resolve));
      await deliver(round);
      jest.advanceTimersByTime(180_000);
      await noticed;
      expect(notices).toBe(round - 1);
      endTurn();
      expect(sessions).toBe(1);
    }
    expect(count("zero_evidence_turn_completed")).toBe(4);
    const fenced = activities.filter(
      (activity) => activity.runtimeError?.errorReason === "runtime_error_fenced",
    );
    expect(fenced).toHaveLength(1);
    expect(fenced[0]?.level).toBe("error");
    expect(JSON.stringify(fenced[0])).toContain("stopped restarting it");
    const after = activities.length;
    await deliver(6);
    jest.advanceTimersByTime(180_000);
    expect(activities).toHaveLength(after);
    expect(count("runtime_error_fenced")).toBe(1);
  } finally {
    jest.useRealTimers();
    await runtime.stop();
    rmSync(state, { recursive: true, force: true });
  }
});
