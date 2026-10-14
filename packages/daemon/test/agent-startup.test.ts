import { afterAll, afterEach, expect, jest, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import type { AgentRuntimeEvent, AgentSession, CodeAgentProvider } from "#src/code-agent/contract";
import { KiroProvider } from "#src/code-agent/kiro/provider";
import { AgentSessionRecoveryError } from "#src/code-agent/contract";
import { AGENT_STARTUP_TIMEOUT_MS } from "#src/agent-runtime/agent-startup";
import { PROCESS_TREE_EXIT_GRACE_MS } from "#src/code-agent/process-tree-cleanup";
import type { AgentActivity } from "@lrm/coforge-sdk/internal";

const workspaceRoot = join(realpathSync(tmpdir()), `coforge-startup-${crypto.randomUUID()}`);
afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
afterEach(() => jest.useRealTimers());

async function harness(provider?: CodeAgentProvider, input?: () => Promise<void>) {
  const connection = { workspaceId: "workspace-a", computerId: "computer-a", workspaceRoot };
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const activities: AgentActivity[] = [];
  const notices: string[] = [];
  const inactive = Promise.withResolvers<void>();
  const idle = Promise.withResolvers<void>();
  const inputStarted = Promise.withResolvers<void>();
  let emit: (event: AgentRuntimeEvent) => void = () => {};
  let disposed = false;
  let live = false;
  const session: AgentSession = {
    get hasLiveTurn() {
      return !disposed && live;
    },
    async sendMessage(text) {
      notices.push(text);
      live = true;
      inputStarted.resolve();
      await input?.();
    },
    async notify() {},
    subscribe(listener) {
      emit = listener;
      return () => {};
    },
    onExit() {
      return () => {};
    },
    async interrupt() {},
    async dispose() {
      disposed = true;
    },
  };
  const runtime = new DaemonRuntime(
    connection,
    () =>
      provider ?? {
        provider: "kiro",
        async createAgentSession() {
          return session;
        },
      },
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
        sendAgentActivity(activity) {
          activities.push(activity);
          if (activity.detailKind === "idle") idle.resolve();
        },
        sendAgentStatus(status) {
          if (status.status === "inactive") inactive.resolve();
        },
      }),
    },
    undefined,
    {
      runtimes: async () => [],
      cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
      catalogs: async () => [],
    },
  );
  await runtime.start(connection);
  return {
    runtime,
    activities,
    notices,
    inactive: inactive.promise,
    idle: idle.promise,
    inputStarted: inputStarted.promise,
    disposed: () => disposed,
    emit: (event: AgentRuntimeEvent) => emit(event),
    start: () => runtime.startAgent("agent-a", { provider: "kiro", model: "auto", reasoning: "" }),
  };
}

test("startup fails and releases the session after 120 seconds without readiness, despite progress pings", async () => {
  const h = await harness();
  try {
    jest.useFakeTimers();
    await h.start();
    h.emit({ type: "progress", source: "transport_alive" });
    jest.advanceTimersByTime(119_999);
    expect(h.disposed()).toBe(false);
    jest.advanceTimersByTime(1);
    await h.inactive;
    expect(h.disposed()).toBe(true);
    expect(h.activities.at(-1)).toMatchObject({ detailKind: "runtime_error", level: "error" });
    expect(h.activities.at(-1)?.detail).toContain("120");
  } finally {
    jest.useRealTimers();
    await h.runtime.stop();
  }
});

test(
  "Kiro's native ACP startup and empty restart both settle Starting to Idle",
  async () => {
    const provider = new KiroProvider({
      command: [
        process.execPath,
        new URL("./fixtures/kiro-acp.ts", import.meta.url).pathname,
        "--complete-startup",
      ],
    });
    const h = await harness(provider);
    try {
      const agent = await h.start();
      await h.idle;
      expect(h.activities.map((activity) => activity.detailKind)).toEqual(["starting", "idle"]);
      const identity = await agent.session.readSessionIdentity!();
      expect(identity?.state).toBe("resumable");
      await h.runtime.stopAgent("agent-a");
      h.activities.length = 0;
      const resumed = await h.runtime.startAgent(
        "agent-a",
        { provider: "kiro", model: "auto", reasoning: "" },
        identity!.sessionId,
      );
      let unsubscribe = () => {};
      const settled = h.activities.some((activity) => activity.detailKind === "idle")
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            unsubscribe = resumed.session.subscribe((event) => {
              if (event.type === "completed") resolve();
            });
          });
      try {
        await settled;
      } finally {
        unsubscribe();
      }
      expect(h.activities.map((activity) => activity.detailKind)).toEqual(["starting", "idle"]);
      if (Bun.env.COFORGE_STARTUP_EVIDENCE_PATH)
        await Bun.write(
          Bun.env.COFORGE_STARTUP_EVIDENCE_PATH,
          JSON.stringify(
            {
              scenario: "Kiro ACP fresh start and empty restart",
              source: "native protocol fixture",
              activities: h.activities.map(({ detailKind, level }) => ({ detailKind, level })),
              outcome: "passed",
            },
            null,
            2,
          ),
        );
    } finally {
      await h.runtime.stop();
    }
  },
  AGENT_STARTUP_TIMEOUT_MS + PROCESS_TREE_EXIT_GRACE_MS,
);

test("a resumed provider that emits failure before rejecting its first input still retries with a fresh session", async () => {
  const modes: Array<string | undefined> = [];
  let disposed = 0;
  const h = await harness({
    provider: "pi",
    async createAgentSession(options) {
      modes.push(options.sessionMode);
      const attempt = modes.length;
      let emit: (event: AgentRuntimeEvent) => void = () => {};
      return {
        hasLiveTurn: false,
        subscribe(listener) {
          emit = listener;
          return () => {};
        },
        onExit() {
          return () => {};
        },
        async sendMessage() {
          if (attempt === 1) {
            emit({ type: "error", message: "Cannot restore provider history" });
            emit({ type: "completed", status: "failed" });
            throw new AgentSessionRecoveryError("provider_replay_rejected");
          }
          emit({ type: "completed", status: "completed" });
        },
        async notify() {},
        async interrupt() {},
        async dispose() {
          disposed++;
        },
        async readSessionIdentity() {
          return { sessionId: attempt === 1 ? "old-session" : "fresh-session", state: "resumable" };
        },
      };
    },
  });
  try {
    await h.runtime.handleAgentStart({
      protocolMajor: 1,
      requestId: "resume-1",
      workspaceId: "workspace-a",
      computerId: "computer-a",
      agentId: "agent-a",
      provider: "pi",
      model: "auto",
      reasoning: "",
      controlEpoch: 1,
      launchId: "launch-1",
      sessionId: "old-session",
      sessionMode: "resume",
    });
    expect(modes).toEqual(["resume", "create"]);
    expect(disposed).toBe(1);
    expect(h.activities.at(-1)?.detailKind).toBe("idle");
  } finally {
    await h.runtime.stop();
  }
});

test("real model work cancels the startup deadline without imposing a turn time limit", async () => {
  const h = await harness();
  try {
    jest.useFakeTimers();
    await h.start();
    h.emit({ type: "thinking-delta", text: "Working on the request." });
    jest.advanceTimersByTime(120_000);
    expect(h.disposed()).toBe(false);
    expect(h.activities.some((activity) => activity.level === "error")).toBe(false);
  } finally {
    jest.useRealTimers();
    await h.runtime.stop();
  }
});

test("an empty resume gets one no-work turn, not the fresh-start prompt", async () => {
  const h = await harness();
  try {
    await h.runtime.startAgent(
      "agent-a",
      { provider: "kiro", model: "auto", reasoning: "" },
      "stored-session",
    );
    expect(h.notices).toEqual([
      "You are back online. No new messages are pending. End this turn without taking action.",
    ]);
  } finally {
    await h.runtime.stop();
  }
});

test("a recovery input admitted before any model work gets the same startup failure cleanup", async () => {
  const h = await harness();
  try {
    await h.runtime.startAgent(
      "agent-a",
      { provider: "kiro", model: "auto", reasoning: "" },
      "stored-session",
      "recovery",
      { unreadSummary: { "#team": 1 } },
    );
    h.emit({ type: "error", message: "Provider authentication failed" });
    h.emit({ type: "completed", status: "failed" });
    await h.inactive;
    expect(h.disposed()).toBe(true);
    expect(h.activities.filter((activity) => activity.detailKind === "runtime_error")).toHaveLength(
      1,
    );
  } finally {
    await h.runtime.stop();
  }
});

test("stopping cancels the old launch's deadline before the next launch", async () => {
  const h = await harness();
  try {
    jest.useFakeTimers();
    await h.start();
    await h.runtime.stopAgent("agent-a");
    h.activities.length = 0;
    jest.advanceTimersByTime(120_000);
    expect(h.activities).toEqual([]);
  } finally {
    jest.useRealTimers();
    await h.runtime.stop();
  }
});

test("a liveness probe preserves Starting until actual model readiness", async () => {
  const h = await harness();
  try {
    await h.start();
    await h.runtime.handleAgentActivityProbe({
      protocolMajor: 1,
      requestId: "probe-1",
      workspaceId: "workspace-a",
      computerId: "computer-a",
      agentId: "agent-a",
      probeId: "probe-1",
    });
    expect(h.activities.at(-1)).toMatchObject({ detailKind: "starting", probeId: "probe-1" });
  } finally {
    await h.runtime.stop();
  }
});

test.each(["agent", "daemon"] as const)(
  "%s Stop cancels a startup still awaiting native input without waiting for admission",
  async (kind) => {
    const gate = Promise.withResolvers<void>();
    const h = await harness(undefined, () => gate.promise);
    try {
      const launch = h.start();
      const outcome = launch.then(
        () => undefined,
        (error: unknown) => error,
      );
      await h.inputStarted;
      await (kind === "agent" ? h.runtime.stopAgent("agent-a") : h.runtime.stop());
      expect(await outcome).toBeInstanceOf(Error);
      expect(((await outcome) as Error).message).toContain("stopping");
      expect(h.disposed()).toBe(true);
    } finally {
      gate.resolve();
      await h.runtime.stop();
    }
  },
);
