import { afterAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentActivity, AgentStatus } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeConfig, AgentRuntimeEvent, AgentSession } from "@lrm/coforge-anvil";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { seedCursor } from "./fixtures/consumed-cursor";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

// macOS tmpdir lives under /var, a symlink; the state store rejects linked ancestors.
const workspaceRoot = join(realpathSync(tmpdir()), `coforge-offline-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};
const config: AgentRuntimeConfig = {
  provider: "claude-code",
  model: "claude-opus",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

/** A runtime with one live Agent whose session the test drives; `dispose()` fires the exit
 * listeners so the harness observes the whole stop the daemon performs. */
async function harness() {
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const exitListeners = new Set<() => void>();
  const activities: AgentActivity[] = [];
  const statuses: AgentStatus[] = [];
  const rejections: { reason: string }[] = [];
  const acknowledgements: string[] = [];
  const notices: string[] = [];
  const noticeWaiters: Array<{ length: number; resolve: () => void }> = [];
  let launches = 0;
  const disposed = Promise.withResolvers<void>();
  let disposedCalled = false;
  const session = {
    async sendMessage() {
      for (const listener of listeners) listener({ type: "completed", status: "completed" });
    },
    async notify(notice: string) {
      notices.push(notice);
      for (let index = noticeWaiters.length - 1; index >= 0; index--) {
        const waiter = noticeWaiters[index]!;
        if (notices.length >= waiter.length) {
          noticeWaiters.splice(index, 1);
          waiter.resolve();
        }
      }
    },
    subscribe(listener: (event: AgentRuntimeEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async interrupt() {},
    onExit(listener: () => void) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    async dispose() {
      disposedCalled = true;
      disposed.resolve();
      for (const listener of exitListeners) listener();
    },
  } satisfies AgentSession;
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "claude-code",
      createAgentSession: async () => {
        launches++;
        return session;
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
        async sendAgentDeliveryAck(ack) {
          acknowledgements.push(ack.deliveryId);
        },
        async sendAgentDeliveryRejection(rejection) {
          rejections.push(rejection);
        },
        sendAgentActivity(activity) {
          activities.push(activity);
        },
        sendAgentStatus(status) {
          statuses.push(status);
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
    activities,
    statuses,
    rejections,
    acknowledgements,
    notices,
    launches: () => launches,
    waitForNotices: (length: number) =>
      notices.length >= length
        ? Promise.resolve()
        : new Promise<void>((resolve) => noticeWaiters.push({ length, resolve })),
    disposed: disposed.promise,
    wasDisposed: () => disposedCalled,
    emit(event: AgentRuntimeEvent) {
      for (const listener of listeners) listener(event);
    },
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

const runtimeErrors = (activities: AgentActivity[]) =>
  activities.filter((activity) => activity.detailKind === "runtime_error");

const entryTexts = (activity: AgentActivity | undefined) =>
  (activity?.entries ?? [])
    .map((entry) => ("text" in entry ? entry.text : ""))
    .filter((text) => text.length > 0);

test("an auth failure ends the process, reports inactive, and shows the re-auth prompt", async () => {
  const h = await harness();
  try {
    h.emit({ type: "error", message: "access token could not be refreshed" });
    await h.disposed;
    const status = h.statuses.findLast((s) => s.agentId === "agent-a");
    expect(status?.status).toBe("inactive");
    const activity = runtimeErrors(h.activities)[0]!;
    expect(activity.runtimeError?.errorClass).toBe("AuthError");
    expect(activity.runtimeError?.requiredAction).toBe("user_reauth");
    expect(activity.detail).toContain("not logged in on this machine");
    expect(activity.detail).not.toContain("access token could not be refreshed");
    expect(entryTexts(activity).some((t) => t.startsWith("Runtime auth diagnostic:"))).toBe(true);
  } finally {
    await h.runtime.stop();
  }
});

test("a plan-access failure reports user_model_access and names the configured model", async () => {
  const h = await harness();
  try {
    h.emit({
      type: "error",
      message: "Your plan does not include access to this model",
    });
    await h.disposed;
    const activity = runtimeErrors(h.activities)[0]!;
    expect(activity.runtimeError?.errorClass).toBe("ModelConfigError");
    expect(activity.runtimeError?.requiredAction).toBe("user_model_access");
    expect(activity.detail).toContain("does not include access to the configured model");
    expect(activity.detail).toContain("claude-opus");
    expect(entryTexts(activity)).toContain(
      "Runtime model-access diagnostic: provider_plan_access_error",
    );
  } finally {
    await h.runtime.stop();
  }
});

test("an unsupported-model failure takes the Agent offline without a named action", async () => {
  const h = await harness();
  try {
    h.emit({ type: "error", message: "The requested model is not supported" });
    await h.disposed;
    const activity = runtimeErrors(h.activities)[0]!;
    expect(activity.runtimeError?.errorClass).toBe("ModelConfigError");
    expect(activity.runtimeError?.requiredAction).toBeUndefined();
    expect(h.statuses.at(-1)?.status).toBe("inactive");
  } finally {
    await h.runtime.stop();
  }
});

test("a retryable failure leaves the process running and the Agent active", async () => {
  const h = await harness();
  try {
    h.emit({ type: "error", message: "stream closed unexpectedly before completion" });
    // End the turn so every synchronous reaction to the error has run, then prove the process
    // was never told to die.
    h.emit({ type: "completed", status: "completed" });
    await Bun.sleep(0);
    expect(h.wasDisposed()).toBe(false);
    expect(h.statuses.at(-1)?.status).not.toBe("inactive");
    expect(runtimeErrors(h.activities).at(-1)?.runtimeError?.requiredAction).toBeUndefined();
  } finally {
    await h.runtime.stop();
  }
});

test("a launch that fails with an auth-shaped throw goes offline with the re-auth prompt", async () => {
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const activities: AgentActivity[] = [];
  const statuses: AgentStatus[] = [];
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "claude-code",
      createAgentSession: async () => {
        throw new Error("Not logged in · Please run /login");
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
        async sendAgentDeliveryAck() {},
        async sendAgentDeliveryRejection() {},
        sendAgentActivity(activity) {
          activities.push(activity);
        },
        sendAgentStatus(status) {
          statuses.push(status);
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  try {
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config).catch(() => {});
    const activity = runtimeErrors(activities)[0]!;
    expect(activity.runtimeError?.errorClass).toBe("AuthError");
    expect(activity.runtimeError?.requiredAction).toBe("user_reauth");
    expect(activity.detail).toContain("not logged in on this machine");
    expect(statuses.at(-1)?.status).toBe("inactive");
    // The launch never produced a session; nothing can listen for its events.
    expect(listeners.size).toBe(0);
  } finally {
    await runtime.stop();
  }
});

test("three identical retryable errors trip the fingerprint fence and take the Agent offline", async () => {
  const h = await harness();
  try {
    for (let attempt = 0; attempt < 3; attempt++)
      h.emit({ type: "error", message: "provider request failed" });
    await h.disposed;
    expect(h.statuses.at(-1)?.status).toBe("inactive");
    const fenced = runtimeErrors(h.activities).at(-1)!;
    expect(fenced.runtimeError?.errorReason).toBe("runtime_error_fenced");
    expect(fenced.runtimeError?.errorClass).toBe("AgentRuntimeError");
    const fingerprint = fenced.runtimeError?.fingerprint;
    expect(fenced.detail).toBe(
      `Runtime stopped after 3 repeated runtime errors with the same fingerprint (${fingerprint}). Last error: provider request failed Restart after the runtime/tooling issue is fixed.`,
    );
    // A later untracked delivery finds no process: the daemon keeps it for the next launch —
    // ACKed, not rejected — restating inactive and the fenced Activity at a higher clientSeq.
    const sentBefore = h.activities.length;
    await h.deliver(1);
    expect(h.rejections).toEqual([]);
    expect(h.acknowledgements).toContain("delivery-1");
    expect(h.launches()).toBe(1);
    expect(h.statuses.at(-1)?.status).toBe("inactive");
    const restated = h.activities.slice(sentBefore).find((a) => a.detailKind === "runtime_error");
    expect(restated?.runtimeError?.errorReason).toBe("runtime_error_fenced");
    expect(restated?.detail).toBe(fenced.detail);
    expect(restated?.clientSeq).toBeGreaterThan(fenced.clientSeq ?? 0);
  } finally {
    await h.runtime.stop();
  }
});

test("three identical terminal-but-wakeable errors also trip the fence, taking the Agent offline", async () => {
  const h = await harness();
  try {
    // "model not found" is terminal but does not itself take the Agent offline; three repeats
    // with no progress between still trip the fingerprint fence, which does.
    for (let attempt = 0; attempt < 3; attempt++)
      h.emit({ type: "error", message: "model gpt-9 not found" });
    await h.disposed;
    expect(h.statuses.at(-1)?.status).toBe("inactive");
    const fenced = runtimeErrors(h.activities).at(-1)!;
    expect(fenced.runtimeError?.errorReason).toBe("runtime_error_fenced");
    expect(fenced.runtimeError?.errorClass).toBe("ModelConfigError");
    expect(fenced.detail).toBe(
      `Runtime stopped after 3 repeated runtime errors with the same fingerprint (${fenced.runtimeError?.fingerprint}). Last error: model gpt-9 not found Restart after the runtime/tooling issue is fixed.`,
    );
  } finally {
    await h.runtime.stop();
  }
});

test("provider output between identical errors resets the fence streak, keeping the Agent active", async () => {
  const h = await harness();
  try {
    h.emit({ type: "error", message: "provider request failed" });
    h.emit({ type: "error", message: "provider request failed" });
    h.emit({ type: "text-delta", text: "partial" });
    h.emit({ type: "error", message: "provider request failed" });
    h.emit({ type: "completed", status: "failed" });
    await Bun.sleep(0);
    expect(h.wasDisposed()).toBe(false);
    expect(h.statuses.at(-1)?.status).not.toBe("inactive");
    expect(runtimeErrors(h.activities).at(-1)?.runtimeError?.errorReason).toBe("runtime_failure");
  } finally {
    await h.runtime.stop();
  }
});

test("a billing-exhausted failure takes the Agent offline with balance wording and no action", async () => {
  const h = await harness();
  try {
    h.emit({ type: "error", message: "HTTP 402 Payment Required: insufficient balance" });
    await h.disposed;
    expect(h.statuses.at(-1)?.status).toBe("inactive");
    const activity = runtimeErrors(h.activities)[0]!;
    expect(activity.runtimeError?.errorClass).toBe("BillingError");
    expect(activity.runtimeError?.errorReason).toBe("billing_exhausted");
    expect(activity.runtimeError?.requiredAction).toBeUndefined();
    expect(activity.detail).toContain("billing or credit balance is exhausted");
    expect(activity.detail).toContain(
      "Add credits or switch this agent to another model or provider",
    );
    expect(activity.detail).toContain("will be delivered when the agent starts again");
    const texts = entryTexts(activity);
    expect(texts[0]).toBe(`Error: ${activity.detail}`);
    expect(texts.some((t) => t.startsWith("Raw error excerpt (redacted):"))).toBe(true);
  } finally {
    await h.runtime.stop();
  }
});

test("a delivery to an Agent taken offline is kept for the next launch and restates the failure", async () => {
  const h = await harness();
  try {
    h.emit({ type: "error", message: "not logged in" });
    await h.disposed;
    const sentBefore = h.activities.length;
    await h.deliver(1);
    expect(h.rejections).toEqual([]);
    expect(h.acknowledgements).toEqual(["delivery-1"]);
    expect(h.launches()).toBe(1);
    expect(h.statuses.at(-1)?.status).toBe("inactive");
    const restated = h.activities.slice(sentBefore).find((a) => a.detailKind === "runtime_error");
    expect(restated?.runtimeError?.requiredAction).toBe("user_reauth");

    // The next launch presents the kept delivery in its first notice.
    const before = h.notices.length;
    await h.runtime.startAgent("agent-a", config);
    await h.waitForNotices(before + 1);
    expect(h.notices.at(-1)).toContain("1 new message");
  } finally {
    await h.runtime.stop();
  }
});

test("deliveries held when the Agent went offline are kept and presented by the next launch", async () => {
  const h = await harness();
  try {
    // A retryable failure holds the next delivery behind its backoff.
    h.emit({ type: "error", message: "provider request failed" });
    await h.deliver(1);
    expect(h.acknowledgements).toEqual(["delivery-1"]);
    expect(h.notices).toEqual([]);
    // Two more identical failures trip the fence and take the Agent offline; the held delivery
    // is kept, not dropped, and a post-offline delivery joins it in the same queue.
    h.emit({ type: "error", message: "provider request failed" });
    h.emit({ type: "error", message: "provider request failed" });
    await h.disposed;
    await h.deliver(2);
    expect(h.acknowledgements).toEqual(["delivery-1", "delivery-2"]);

    const before = h.notices.length;
    await h.runtime.startAgent("agent-a", config);
    await h.waitForNotices(before + 1);
    expect(h.notices.at(-1)).toContain("2 new messages");
  } finally {
    await h.runtime.stop();
  }
});

test("an already-consumed delivery to an offline Agent is ACKed and dropped, not queued", async () => {
  const h = await harness();
  try {
    h.emit({ type: "error", message: "not logged in" });
    await h.disposed;
    // The consumed cursor already covers this delivery (durable, outlives the process).
    await seedCursor("agent-a", {
      targets: { "@gone": { conversationId: "conversation-gone", seq: 5 } },
      aliases: {},
      nextReadOrder: 1,
    });
    await h.runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "request-gone",
      messageId: "message-gone",
      deliveryId: "delivery-gone",
      sequence: 3,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-gone",
      agentId: "agent-a",
      body: "already reviewed",
      method: "agent:v1:message:deliver",
      target: "@gone",
    });
    expect(h.acknowledgements).toEqual(["delivery-gone"]);
    expect(h.rejections).toEqual([]);

    // A custody delivery, then a fresh launch: only the kept one is presented.
    await h.deliver(9);
    const before = h.notices.length;
    await h.runtime.startAgent("agent-a", config);
    await h.waitForNotices(before + 1);
    expect(h.notices.at(-1)).toContain("1 new message");
    expect(h.notices.at(-1)).not.toContain("@gone");
  } finally {
    await h.runtime.stop();
  }
});

test("an explicit Stop after an offline error clears the record: a delivery is no_process again", async () => {
  const h = await harness();
  try {
    h.emit({ type: "error", message: "not logged in" });
    await h.disposed;
    await h.runtime.stopAgent("agent-a");
    const sentBefore = h.activities.length;
    await h.deliver(1);
    expect(h.rejections.map((r) => r.reason)).toEqual(["no_process"]);
    expect(h.acknowledgements).toEqual([]);
    // No restatement: the record was cleared with the Stop.
    expect(h.activities.slice(sentBefore).filter((a) => a.detailKind === "runtime_error")).toEqual(
      [],
    );
  } finally {
    await h.runtime.stop();
  }
});
