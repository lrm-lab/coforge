import { afterAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResetCreditOutcome } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeConfig, AgentRuntimeEvent, AgentSession } from "@lrm/coforge-anvil";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

// macOS tmpdir lives under /var, a symlink; the state store rejects linked ancestors.
const workspaceRoot = join(realpathSync(tmpdir()), `coforge-reset-credit-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};
const config: AgentRuntimeConfig = {
  provider: "codex",
  model: "default",
  modelProvider: "openai",
  reasoning: "balanced",
};
const key = "0b8c1f3e-52d7-4a9c-9a4e-6f1d2c3b4a59";
const HOUR_MS = 60 * 60_000;

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

/** A runtime with one live Codex Agent whose session the test drives, and an adapter that answers
 * a reset credit attempt with `outcome`. */
async function harness(outcome: ResetCreditOutcome) {
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const notices: string[] = [];
  const noticed = Promise.withResolvers<void>();
  const acknowledged = Promise.withResolvers<void>();
  const asked: string[] = [];
  const session = {
    async sendMessage() {
      for (const listener of listeners) listener({ type: "completed", status: "completed" });
    },
    async notify(notice: string) {
      notices.push(notice);
      noticed.resolve();
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
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "codex",
      createAgentSession: async () => session,
      consumeResetCredit: async (options) => {
        asked.push(options.idempotencyKey);
        return outcome;
      },
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
        async sendAgentDeliveryAck() {
          acknowledged.resolve();
        },
        sendAgentActivity() {},
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  await runtime.start(connection);
  await runtime.startAgent("agent-a", config);
  return {
    runtime,
    notices,
    asked,
    acknowledged: acknowledged.promise,
    noticed: noticed.promise,
    emit(event: AgentRuntimeEvent) {
      for (const listener of listeners) listener(event);
    },
    deliver: () =>
      runtime.handleAgentMessage({
        protocolMajor: 1,
        requestId: "request-1",
        messageId: "message-1",
        deliveryId: "delivery-1",
        sequence: 1,
        workspaceId: connection.workspaceId,
        conversationId: "conversation-a",
        agentId: "agent-a",
        body: "body-1",
        method: "agent:v1:message:deliver",
        target: "@ada",
      }),
  };
}

/** The turn fails on an exhausted quota that resets in three hours, so the Agent's deliveries wait. */
function failOnQuota(emit: (event: AgentRuntimeEvent) => void) {
  emit({
    type: "error",
    message: "You've hit your usage limit",
    providerErrorCode: "rate_limit",
    providerLimit: {
      kind: "quota_exhausted",
      resetsAt: new Date(Date.now() + 3 * HOUR_MS).toISOString(),
    },
  });
  emit({ type: "completed", status: "failed" });
}

test("a reset lets the Codex Agent that waited out its rate limit receive its held delivery at once", async () => {
  const { runtime, notices, asked, acknowledged, noticed, emit, deliver } = await harness("reset");
  try {
    failOnQuota(emit);
    await deliver();
    await acknowledged;
    expect(notices).toEqual([]);

    const result = await runtime.consumeResetCredit("codex", key);

    expect(result.outcome).toBe("reset");
    expect(asked).toEqual([key]);
    await noticed;
    expect(notices).toHaveLength(1);
  } finally {
    await runtime.stop();
  }
});

test("any other outcome leaves the Agent waiting", async () => {
  const { runtime, notices, acknowledged, emit, deliver } = await harness("no_credit");
  try {
    failOnQuota(emit);
    await deliver();
    await acknowledged;

    const result = await runtime.consumeResetCredit("codex", key);

    expect(result.outcome).toBe("no_credit");
    expect(notices).toEqual([]);
  } finally {
    await runtime.stop();
  }
});
