import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent, AgentSession, AgentSessionOptions } from "@lrm/coforge-anvil";
import type { AgentActivity } from "@lrm/coforge-sdk/internal";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

class FakeSession {
  readonly #exitListeners = new Set<() => void>();
  readonly #eventListeners = new Set<(event: AgentRuntimeEvent) => void>();

  async sendMessage() {}
  async interrupt() {}
  async dispose() {}
  subscribe(listener: (event: AgentRuntimeEvent) => void) {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }
  onExit(listener: () => void) {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }
  emit(event: AgentRuntimeEvent) {
    for (const listener of this.#eventListeners) listener(event);
  }
  crash() {
    for (const listener of this.#exitListeners) listener();
  }
}

const config = {
  provider: "pi" as const,
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "coforge-resumed-crash-"));
  const connection = {
    computerId: "computer-resumed-crash",
    workspaceId: "workspace-resumed-crash",
    workspaceRoot: root,
  };
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const activities: AgentActivity[] = [];
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
    invalidates,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("two silent crashes within seconds of resuming one session invalidate it and cold-start", async () => {
  const h = await harness();
  try {
    await h.runtime.startAgent("agent-a", config, "sess-1");
    h.sessions[0]!.crash();
    await settle();
    // The remembered session resumes on the next launch; it crashes the same way.
    await h.runtime.startAgent("agent-a", config);
    h.sessions[1]!.crash();
    await settle();
    // The threshold cold-starts a fresh session through the ordinary launch gate.
    await settle();

    expect(h.launches.map((l) => l.sessionId)).toEqual(["sess-1", "sess-1", undefined]);
    expect(h.launches[2]!.sessionMode).toBe("create");
    expect(h.invalidates).toHaveLength(1);
    expect(h.invalidates[0]).toMatchObject({
      agentId: "agent-a",
      provider: "pi",
      sessionId: "sess-1",
      reason: "repeated_early_crash",
    });
    expect(h.activities.some((a) => a.detail?.includes("keeps crashing on resume"))).toBe(true);
  } finally {
    await h.runtime.stop();
    await h.cleanup();
  }
});

test("model output before the crash resets the streak instead of falling back", async () => {
  const h = await harness();
  try {
    await h.runtime.startAgent("agent-a", config, "sess-1");
    h.sessions[0]!.crash();
    await settle();
    await h.runtime.startAgent("agent-a", config);
    // Text before the exit proves the resumed session itself produced output.
    h.sessions[1]!.emit({ type: "text-delta", text: "still alive" });
    h.sessions[1]!.crash();
    await settle();
    await h.runtime.startAgent("agent-a", config);
    h.sessions[2]!.crash();
    await settle();

    // Only the last two closes counted: one more qualifying close is still short of the
    // threshold, so no invalidation and no fresh session yet.
    expect(h.invalidates).toHaveLength(0);
    expect(h.launches.every((l) => l.sessionId === "sess-1")).toBe(true);
  } finally {
    await h.runtime.stop();
    await h.cleanup();
  }
});

test("a fresh session's early crash never counts toward the stale session", async () => {
  const h = await harness();
  try {
    // A create-mode launch carries no resume pointer: its crash is not a resumed crash.
    await h.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      "create",
    );
    h.sessions[0]!.crash();
    await settle();
    await h.runtime.startAgent("agent-a", config);
    h.sessions[1]!.crash();
    await settle();

    expect(h.invalidates).toHaveLength(0);
  } finally {
    await h.runtime.stop();
    await h.cleanup();
  }
});
