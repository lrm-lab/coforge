import { afterAll, afterEach, expect, jest, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import type { AgentRuntimeEvent, AgentSession, CodeAgentProvider } from "#src/code-agent/contract";
import { KiroProvider } from "#src/code-agent/kiro/provider";
import { AgentSessionRecoveryError } from "#src/code-agent/contract";
import {
  AGENT_STARTUP_TIMEOUT_MS,
  AgentStartup,
  agentStartupInput,
} from "#src/agent-runtime/agent-startup";
import { PROCESS_TREE_EXIT_GRACE_MS } from "#src/code-agent/process-tree-cleanup";
import type { AgentActivity } from "@lrm/coforge-sdk/internal";
import { captureDaemonLogs } from "./log-capture";

const workspaceRoot = join(realpathSync(tmpdir()), `coforge-startup-${crypto.randomUUID()}`);
afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
afterEach(() => jest.useRealTimers());

type Emit = (event: AgentRuntimeEvent) => void;
async function harness(provider?: CodeAgentProvider, input?: (emit: Emit) => Promise<void>) {
  const connection = { workspaceId: "workspace-a", computerId: "computer-a", workspaceRoot };
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const activities: AgentActivity[] = [];
  const notices: string[] = [];
  const statuses: string[] = [];
  const inactive = Promise.withResolvers<void>();
  const idle = Promise.withResolvers<void>();
  const inputStarted = Promise.withResolvers<void>();
  let emit: Emit = () => {};
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
      await input?.(emit);
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
          statuses.push(status.status);
          if (status.status === "inactive") inactive.resolve();
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  await runtime.start(connection);
  return {
    runtime,
    activities,
    notices,
    statuses,
    inactive: inactive.promise,
    idle: idle.promise,
    inputStarted: inputStarted.promise,
    disposed: () => disposed,
    emit: (event: AgentRuntimeEvent) => emit(event),
    start: () => runtime.startAgent("agent-a", { provider: "kiro", model: "auto", reasoning: "" }),
  };
}

const runtimeErrors = (h: { activities: AgentActivity[] }) =>
  h.activities.filter((activity) => activity.detailKind === "runtime_error");

test("a fresh session after reset or migration recovers existing files and tasks, without a new greeting", () => {
  const input = agentStartupInput(false);
  expect(input).toContain("You are starting a fresh session.");
  expect(input).toContain("read MEMORY.md and notes/active-context.md if present");
  expect(input).toContain("check unfinished tasks assigned to you once");
  expect(input).toContain("If no actionable work remains, end this turn silently.");
  expect(input).toContain("Do not send a startup announcement or repeat your introduction.");
});

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
  const inputs: string[] = [];
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
        async sendMessage(text) {
          inputs.push(text);
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
    expect(inputs[1]).toContain("To recover your work without previous session context");
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

test("an empty resume recovers existing work before waiting silently", async () => {
  const h = await harness();
  try {
    await h.runtime.startAgent(
      "agent-a",
      { provider: "kiro", model: "auto", reasoning: "" },
      "stored-session",
    );
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("You are back online.");
    expect(h.notices[0]).toContain("Use your existing session context first.");
    expect(h.notices[0]).toContain("read MEMORY.md and notes/active-context.md if present");
    expect(h.notices[0]).toContain("check unfinished tasks assigned to you once");
    expect(h.notices[0]).toContain("If no actionable work remains, end this turn silently.");
    expect(h.notices[0]).toContain(
      "Do not send a startup announcement or repeat your introduction.",
    );
  } finally {
    await h.runtime.stop();
  }
});

test("a model error on an admitted recovery turn is an ordinary runtime error; the launch stands", async () => {
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
    await Bun.sleep(0);
    expect(h.disposed()).toBe(false);
    expect(h.statuses).not.toContain("inactive");
    expect(runtimeErrors(h)).toHaveLength(1);
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
    expect(h.activities.at(-1)).toMatchObject({
      detailKind: "starting",
      detail: "Starting…",
      probeId: "probe-1",
    });
  } finally {
    await h.runtime.stop();
  }
});

test("a liveness probe answers Message received over Starting while a message waits unread", async () => {
  const h = await harness();
  const probe = (probeId: string) =>
    h.runtime.handleAgentActivityProbe({
      protocolMajor: 1,
      requestId: `request-${probeId}`,
      workspaceId: "workspace-a",
      computerId: "computer-a",
      agentId: "agent-a",
      probeId,
    });
  try {
    await h.start();
    await h.runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "request-1",
      messageId: "message-1",
      deliveryId: "delivery-1",
      sequence: 1,
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      agentId: "agent-a",
      body: "body-1",
      method: "agent:v1:message:deliver",
      target: "@ada",
    });
    await probe("probe-1");
    expect(h.activities.at(-1)).toMatchObject({
      detailKind: "message_received",
      detail: "Message received",
      probeId: "probe-1",
    });

    // Without the unread message the same launch is still starting.
    h.runtime.handleAgentInboxPurge({
      protocolMajor: 1,
      requestId: "purge-1",
      workspaceId: "workspace-a",
      computerId: "computer-a",
      agentId: "agent-a",
      conversationIds: ["conversation-a"],
      targets: ["@ada"],
      reason: "member_removed",
    });
    await probe("probe-2");
    expect(h.activities.at(-1)).toMatchObject({ detailKind: "starting", probeId: "probe-2" });
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

type ProviderLimit = NonNullable<Extract<AgentRuntimeEvent, { type: "error" }>["providerLimit"]>;
const usageLimitError = (providerLimit: ProviderLimit): AgentRuntimeEvent => ({
  type: "error",
  message: "You've hit your session limit · resets 9:30pm",
  providerErrorCode: "rate_limit",
  providerLimit,
});

test.each<ProviderLimit>([
  { kind: "quota_exhausted", resetsAt: "2026-10-20T13:30:00.000Z" },
  { kind: "transient_rate_limit" },
])("a provider usage limit ($kind) is readiness, not a startup failure", async (providerLimit) => {
  const startup = new AgentStartup(() => {});
  try {
    // Input the provider holds for the whole turn: only readiness settles it.
    const ran = startup.run(new Promise<void>(() => {}));
    startup.observe(usageLimitError(providerLimit));
    expect(startup.waiting).toBe(false);
    await ran;
    startup.observe({ type: "completed", status: "failed" });
    expect(startup.endsLaunch(new Error("late rejection"), 0)).toBe(false);
  } finally {
    startup.dispose();
  }
});

test("a bare startup error closes the window but answers no input; a failed outcome does", () => {
  const startup = new AgentStartup(() => {});
  try {
    startup.observe({ type: "error", message: "Provider authentication failed" });
    expect(startup.waiting).toBe(false);
    expect(startup.errorObserved).toBe(true);
    expect(startup.endsLaunch(new Error("turn/start failed"), 0)).toBe(true);
    startup.observe({ type: "completed", status: "failed" });
    expect(startup.endsLaunch(new Error("turn/start failed"), 0)).toBe(false);
    // A later input the model has not answered yet is judged on its own.
    expect(startup.endsLaunch(new Error("notice refused"), startup.responses)).toBe(true);
    const recovery = new AgentSessionRecoveryError("provider_replay_rejected");
    expect(startup.endsLaunch(recovery, 0)).toBe(true);
  } finally {
    startup.dispose();
  }
});

test("a usage limit on the startup turn leaves the Agent's launch running", async () => {
  const h = await harness();
  try {
    const { records } = await captureDaemonLogs(async () => {
      await h.start();
      h.emit(usageLimitError({ kind: "quota_exhausted", resetsAt: "2026-10-20T13:30:00.000Z" }));
      h.emit({ type: "completed", status: "failed" });
    });
    const events = records.map((record) => record.properties.event);
    expect(events).not.toContain("agent_runtime:startup_timed_out");
    expect(events).not.toContain("agent.startup_input.rejected");
    expect(h.disposed()).toBe(false);
    // The limit takes the ordinary runtime-error path (the provider-limit hold) instead.
    const errors = runtimeErrors(h);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.runtimeError?.errorReason).toBe("quota_exhausted");
    expect(h.statuses).not.toContain("inactive");
  } finally {
    await h.runtime.stop();
  }
});

test.each([
  ["no events (Codex turn/start error)", []],
  ["a bare error event (Grok, Kiro)", [{ type: "error", message: "Prompt failed" }]],
] as [string, AgentRuntimeEvent[]][])(
  "a startup input rejected after %s ends the launch with one runtime error",
  async (_, events) => {
    const h = await harness(undefined, async (emit) => {
      for (const event of events) emit(event);
      throw new Error("Prompt failed");
    });
    try {
      await expect(h.start()).rejects.toThrow("Prompt failed");
      expect(h.disposed()).toBe(true);
      expect(h.statuses).toContain("inactive");
      expect(runtimeErrors(h)).toHaveLength(1);
      expect(runtimeErrors(h)[0]?.detail).toContain("Prompt failed");
    } finally {
      await h.runtime.stop();
    }
  },
);

test.each([
  ["a failed turn (Pi)", "Provider authentication failed"],
  ["a quota error without a provider limit", "provider.quota (HTTP 429): quota exceeded"],
])("a startup input rejected after %s leaves the launch running", async (_, message) => {
  const h = await harness(undefined, async (emit) => {
    emit({ type: "error", message });
    emit({ type: "completed", status: "failed" });
    throw new Error(message);
  });
  try {
    const { records } = await captureDaemonLogs(() => h.start());
    const events = records.map((record) => record.properties.event);
    expect(events).toContain("agent.startup_input.rejected");
    expect(events).not.toContain("agent_runtime:startup_timed_out");
    expect(h.disposed()).toBe(false);
    expect(h.statuses).not.toContain("inactive");
    expect(runtimeErrors(h)).toHaveLength(1);
  } finally {
    await h.runtime.stop();
  }
});

test("a bare startup error alone cancels the 120-second deadline", async () => {
  const h = await harness();
  try {
    jest.useFakeTimers();
    await h.start();
    h.emit({ type: "error", message: "Provider authentication failed" });
    jest.advanceTimersByTime(AGENT_STARTUP_TIMEOUT_MS);
    expect(h.disposed()).toBe(false);
  } finally {
    jest.useRealTimers();
    await h.runtime.stop();
  }
});
