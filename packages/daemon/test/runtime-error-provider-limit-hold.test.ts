import { afterAll, afterEach, expect, jest, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentActivity } from "@lrm/coforge-sdk/internal";
import { runtimeErrorDeliveryBackoffDelayMs } from "#src/agent-runtime/runtime-error-recovery";
import type { AgentRuntimeConfig, AgentRuntimeEvent, AgentSession } from "#src/code-agent/contract";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

// macOS tmpdir lives under /var, a symlink; the state store rejects linked ancestors.
const workspaceRoot = join(realpathSync(tmpdir()), `coforge-limit-hold-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};
const config: AgentRuntimeConfig = {
  provider: "claude-code",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};
const QUOTA_TEXT = "You've hit your session limit · resets 3:45pm";
const RESETS_AT = "2100-01-01T00:00:00.000Z";
/** The first backoff delay with its jitter at most (runtime-error-recovery.ts). */
const FIRST_BACKOFF_MS = runtimeErrorDeliveryBackoffDelayMs(1, { jitterRandom: () => 1 }) + 1;

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
afterEach(() => jest.useRealTimers());

/** A runtime with one live Agent whose session the test drives, recording its notices and
 * Activity. */
async function harness() {
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const notices: string[] = [];
  const noticed = Promise.withResolvers<void>();
  const acknowledged = Promise.withResolvers<void>();
  const activities: AgentActivity[] = [];
  const session = {
    async sendMessage() {
      // Startup's first turn ends at once: these tests are about later deliveries.
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
    () => ({ provider: "claude-code", createAgentSession: async () => session }),
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
        sendAgentActivity(activity) {
          activities.push(activity);
        },
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
    acknowledged: acknowledged.promise,
    activities,
    emit(event: AgentRuntimeEvent) {
      for (const listener of listeners) listener(event);
    },
    /** Resolves at the first notice: the observable completion of a released hold. */
    noticed: noticed.promise,
    deliver: (sequence: number) =>
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
      }),
  };
}

test("a Claude quota limit keeps its delivery backoff across the failed turn's end", async () => {
  const { runtime, notices, acknowledged, activities, emit, noticed, deliver } = await harness();
  jest.useFakeTimers();
  try {
    emit({
      type: "error",
      message: QUOTA_TEXT,
      providerErrorCode: "rate_limit",
      providerLimit: { kind: "quota_exhausted", resetsAt: RESETS_AT },
    });
    emit({ type: "completed", status: "failed" });
    await deliver(1);
    // Held: acknowledged without a notice, unlike the same text unclassified, whose backoff
    // its turn end ends (daemon-runtime.test.ts, "the same error ending every turn ...").
    await acknowledged;
    expect(notices).toEqual([]);
    expect(activities.find((activity) => activity.detailKind === "runtime_error")).toMatchObject({
      detail: `${QUOTA_TEXT} (limit resets at ${RESETS_AT})`,
      runtimeError: { errorClass: "RateLimitError", errorReason: "quota_exhausted" },
    });

    jest.advanceTimersByTime(FIRST_BACKOFF_MS);
    await noticed;
    expect(notices).toHaveLength(1);
  } finally {
    await runtime.stop();
  }
});
