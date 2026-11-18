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
const crash = { code: 1, signal: null } as const;

type Harness = Awaited<ReturnType<typeof harness>>;

async function crashNext(h: Harness, exit: AgentSessionExit = crash, session?: string) {
  await h.runtime.startAgent("agent-a", config, session);
  h.sessions.at(-1)!.crash(exit);
  await settle();
}

const stoppedForExits = (h: Harness) => [
  ...new Set(
    h.activities
      .filter((a) => a.detail?.includes("times in a row without producing any output"))
      .map((a) => a.detail),
  ),
];

test("five unclean exits in a row with no output stop the restarts and say how to retry", async () => {
  const h = await harness();
  try {
    for (let exit = 0; exit < 4; exit += 1) await crashNext(h);
    expect(stoppedForExits(h)).toHaveLength(0);
    await crashNext(h);
    const stopped = stoppedForExits(h);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toBe(
      "The runtime exited 5 times in a row without producing any output, so CoForge stopped restarting it. Restart the Agent to try again.",
    );
  } finally {
    await h.runtime.stop();
    await h.cleanup();
  }
});

test("model output between exits clears the count", async () => {
  const h = await harness();
  try {
    for (let exit = 0; exit < 4; exit += 1) await crashNext(h);
    await h.runtime.startAgent("agent-a", config);
    h.sessions.at(-1)!.emit({ type: "text-delta", text: "alive" });
    h.sessions.at(-1)!.crash(crash);
    await settle();
    for (let exit = 0; exit < 3; exit += 1) await crashNext(h);
    expect(stoppedForExits(h)).toHaveLength(0);
    await crashNext(h);
    expect(stoppedForExits(h)).toHaveLength(1);
  } finally {
    await h.runtime.stop();
    await h.cleanup();
  }
});

test("a subagent's output does not clear the count", async () => {
  const h = await harness();
  try {
    for (let exit = 0; exit < 4; exit += 1) await crashNext(h);
    await h.runtime.startAgent("agent-a", config);
    h.sessions.at(-1)!.emit({
      type: "text-delta",
      text: "helper",
      subagent: { id: "sub-1" },
    } as never);
    h.sessions.at(-1)!.crash(crash);
    await settle();
    expect(stoppedForExits(h)).toHaveLength(1);
  } finally {
    await h.runtime.stop();
    await h.cleanup();
  }
});

test("a Stop clears the count", async () => {
  const h = await harness();
  try {
    for (let exit = 0; exit < 4; exit += 1) await crashNext(h);
    await h.runtime.stopAgent("agent-a");
    for (let exit = 0; exit < 4; exit += 1) await crashNext(h);
    expect(stoppedForExits(h)).toHaveLength(0);
  } finally {
    await h.runtime.stop();
    await h.cleanup();
  }
});

test("exits that are rate limits, connection or server failures, or clean never count", async () => {
  const h = await harness();
  try {
    const failures = [
      "You've hit your usage limit. try again in 5 hours.",
      "HTTP 503: service unavailable",
      "fetch failed: ECONNRESET",
    ];
    for (const message of failures)
      for (let exit = 0; exit < 5; exit += 1) {
        await h.runtime.startAgent("agent-a", config);
        h.sessions.at(-1)!.emit({ type: "error", message, retryable: true });
        h.sessions.at(-1)!.crash(crash);
        await settle();
      }
    for (let exit = 0; exit < 5; exit += 1) await crashNext(h, { code: 0, signal: null });
    expect(stoppedForExits(h)).toHaveLength(0);
  } finally {
    await h.runtime.stop();
    await h.cleanup();
  }
});

test("the exit that cold-starts a resumed session counts once, not as a resume failure and a crash", async () => {
  const h = await harness();
  try {
    await crashNext(h, crash, "sess-1");
    await crashNext(h);
    await settle();
    expect(h.invalidates).toHaveLength(1);
    expect(stoppedForExits(h)).toHaveLength(0);
    h.sessions.at(-1)!.crash(crash);
    await settle();
    await crashNext(h);
    expect(stoppedForExits(h)).toHaveLength(0);
    await crashNext(h);
    expect(stoppedForExits(h)).toHaveLength(1);
    expect(stoppedForExits(h)[0]).toContain("exited 5 times");
  } finally {
    await h.runtime.stop();
    await h.cleanup();
  }
});

test("exits after a stream that closed before response.completed count toward the stop", async () => {
  const h = await harness();
  try {
    const hosts = ["alpha", "bravo", "charlie", "delta", "echo"];
    for (const [exit, host] of hosts.entries()) {
      await h.runtime.startAgent("agent-a", config);
      h.sessions.at(-1)!.emit({
        type: "error",
        message: `stream closed before response.completed from ${host}`,
        retryable: true,
      });
      h.sessions.at(-1)!.crash(crash);
      await settle();
      expect(stoppedForExits(h)).toHaveLength(exit < 4 ? 0 : 1);
    }
  } finally {
    await h.runtime.stop();
    await h.cleanup();
  }
});
