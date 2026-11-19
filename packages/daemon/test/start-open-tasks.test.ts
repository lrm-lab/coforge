import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent, AgentSessionOptions, CodeAgentProvider } from "@lrm/coforge-anvil";
import type { AgentStartIntent, AgentStartOpenTasks } from "@lrm/coforge-sdk/internal";
import { agentStartupCatchupInput, agentStartupInput } from "#src/agent-runtime/agent-startup";
import { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import { prependSessionMemory } from "#src/agent-runtime/session-memory-briefing";
import { formatStartOpenTaskLines } from "#src/agent-runtime/start-open-tasks";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { planRecovery } from "#src/daemon-runtime/agent-message-attention-recovery";
import { mergeCarried } from "#src/daemon-runtime/provider-replay-recovery";
import { DaemonRuntime, type DaemonConfig } from "#src/daemon-runtime/runtime";
import { recoveryOf, type AgentInputQueue } from "#src/daemon-runtime/runtime-launch-intent";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

const sampleOpenTasks: AgentStartOpenTasks = {
  tasks: [
    { ref: "#coforge:#12", title: "Ship start open tasks", status: "in_progress" },
    { ref: "dm:@ada:#3", title: "Review release checklist", status: "todo" },
  ],
  more: 2,
};

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "coforge-open-tasks-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function createRuntimeHarness() {
  const connection: DaemonConfig = {
    computerId: "computer-a",
    workspaceId: "workspace-a",
    workspaceRoot: join(tempDir, "workspaces"),
  };
  const stateDir = join(tempDir, "state");
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  await mkdir(
    agentWorkspaceDirectory(connection.workspaceRoot, connection.workspaceId, "agent-a"),
    {
      recursive: true,
    },
  );

  const inputs: string[] = [];
  const provider: CodeAgentProvider = {
    provider: "codex",
    async createAgentSession(sessionOptions: AgentSessionOptions) {
      const listeners = new Set<(event: AgentRuntimeEvent) => void>();
      const exitListeners = new Set<() => void>();
      const emit = (event: AgentRuntimeEvent) => {
        for (const listener of listeners) listener(event);
      };
      await sessionOptions.onSessionId?.(sessionOptions.sessionId ?? "native-1");
      return {
        hasLiveTurn: false,
        async sendMessage(text) {
          inputs.push(text);
          emit({ type: "text-delta", text: "ok" });
          emit({ type: "completed", status: "completed" });
        },
        async notify(text) {
          inputs.push(text);
          emit({ type: "text-delta", text: "ok" });
          emit({ type: "completed", status: "completed" });
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async interrupt() {},
        onExit(listener) {
          exitListeners.add(listener);
          return () => exitListeners.delete(listener);
        },
        async dispose() {
          for (const listener of Array.from(exitListeners)) listener();
        },
      };
    },
  };

  const runtime = new DaemonRuntime(
    connection,
    () => provider,
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentLaunchConfig() {
          return {
            agentApiKey: `sk_agent_${"a".repeat(43)}`,
            envVars: {},
            identity: { name: "agent-a", displayName: "Agent A", description: "Helper" },
          };
        },
        async revokeAgentApiKey() {},
        async reportAgentSession() {},
        sendAgentActivity() {},
        sendAgentStatus() {},
        sendAgentContextUsage() {},
        async sendAgentControlResult() {},
        async sendAgentDeliveryAck() {},
        async sendAgentDeliveryRejection() {},
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    stateDir,
  );
  await runtime.start(connection);
  return { runtime, inputs, connection };
}

function baseStartIntent(
  connection: DaemonConfig,
  overrides: Partial<AgentStartIntent> = {},
): AgentStartIntent {
  return {
    protocolMajor: 1,
    requestId: "req-1",
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "agent-a",
    provider: "codex",
    model: "gpt-5",
    reasoning: "medium",
    ...overrides,
  };
}

describe("start open tasks formatting", () => {
  test("sanitizes newlines, control chars, and truncates long titles without splitting surrogate pairs", () => {
    const keepEmoji = `${"a".repeat(138)}🚀tail`;
    const dropEmoji = `${"a".repeat(139)}🚀tail`;
    const lines = formatStartOpenTaskLines({
      tasks: [
        {
          ref: "#coforge:#7\nignored\u001b[31m",
          title: "Line 1\r\nLine 2\t\u0000\u007fmore",
          status: "in_progress",
        },
        { ref: "#coforge:#8", title: keepEmoji, status: "todo" },
        { ref: "#coforge:#9", title: dropEmoji, status: "todo" },
      ],
      more: 3,
    });
    expect(lines).toContain("- #coforge:#7 ignored [31m [in_progress] Line 1 Line 2 more");
    expect(lines).toContain(`- #coforge:#8 [todo] ${"a".repeat(138)}🚀…`);
    expect(lines).toContain(`- #coforge:#9 [todo] ${"a".repeat(139)}…`);
    expect(lines).not.toContain("\uD83D…");
    expect(lines).not.toContain("\u001b");
    expect(lines).not.toContain("\u0000");
    expect(lines).toContain("- …and 3 more: `coforge task list --mine`");
  });

  test("agentStartupInput lists assigned open tasks when present and stays unchanged when absent", () => {
    const plain = agentStartupInput(true, false);
    expect(plain).toContain("end this turn silently");
    expect(plain).toContain("check unfinished tasks assigned to you once");
    expect(plain).not.toContain("Open tasks currently assigned to you");

    const withTasks = agentStartupInput(true, false, sampleOpenTasks);
    expect(withTasks).toContain("Open tasks currently assigned to you:");
    expect(withTasks).toContain("- #coforge:#12 [in_progress] Ship start open tasks");
    expect(withTasks).toContain("- dm:@ada:#3 [todo] Review release checklist");
    expect(withTasks).toContain("- …and 2 more: `coforge task list --mine`");
    expect(withTasks).toContain("coforge task view");
    expect(withTasks).toContain("do not invent work or scan unrelated channels and projects");
    expect(withTasks).not.toContain("check unfinished tasks assigned to you once");

    const freshWithMemory = agentStartupInput(false, true, sampleOpenTasks);
    expect(freshWithMemory).toContain("Open tasks currently assigned to you:");
    expect(freshWithMemory).not.toContain("read MEMORY.md");
    expect(freshWithMemory).not.toContain("check unfinished tasks assigned to you once");
  });

  test("agentStartupCatchupInput appends open tasks on summary-only catch-up", () => {
    const plain = agentStartupCatchupInput(["#general 2 new messages"]);
    expect(plain).toContain("then end this turn");
    expect(plain).not.toContain("Open tasks currently assigned to you");

    const withTasks = agentStartupCatchupInput(["#general 2 new messages"], false, sampleOpenTasks);
    expect(withTasks).toContain("#general 2 new messages");
    expect(withTasks).toContain("Open tasks currently assigned to you:");
    expect(withTasks).toContain("- #coforge:#12 [in_progress] Ship start open tasks");
    expect(withTasks).not.toContain(", then end this turn.");
    expect(withTasks).toContain("After catching up:");
  });
});

describe("start open tasks propagation", () => {
  test("prependSessionMemory preserves openTasks when rewriting a fresh starter", () => {
    const completion = Promise.withResolvers<void>();
    const queue: AgentInputQueue = {
      closed: false,
      items: [
        {
          kind: "startup",
          text: agentStartupInput(true, false, sampleOpenTasks),
          openTasks: sampleOpenTasks,
          completion: { resolve: completion.resolve, reject: completion.reject },
        },
      ],
    };
    prependSessionMemory(queue, {
      text: "<memory>saved context</memory>",
      complete: true,
    });
    expect(queue.items).toHaveLength(1);
    const starter = queue.items[0];
    expect(starter?.kind).toBe("startup");
    if (starter?.kind === "startup") {
      expect(starter.text).toContain("<memory>saved context</memory>");
      expect(starter.text).toContain("- #coforge:#12 [in_progress] Ship start open tasks");
      expect(starter.text).not.toContain("read MEMORY.md");
    }
  });

  test("planRecovery includes openTasks only for summary-only notices", () => {
    const summaryPlan = planRecovery({
      agentId: "agent-1",
      messages: [],
      unreadSummary: { "#general": 3 },
      unreadConversationIds: {},
      snapshotMessages: [],
      openTasks: sampleOpenTasks,
      currentAttention: new Map(),
      seenDeliveryIds: new Set(),
      seenMessageIds: new Set(),
      alreadyRead: () => false,
      alreadyNotified: () => false,
      decide: () => {},
    });
    expect(summaryPlan?.notice).toContain("#general 3 new messages");
    expect(summaryPlan?.notice).toContain("- #coforge:#12 [in_progress] Ship start open tasks");

    const directPlan = planRecovery({
      agentId: "agent-1",
      messages: [
        {
          messageId: "m-1",
          deliveryId: "d-1",
          conversationId: "c-1",
          sequence: 1,
          target: "#general",
          latestSenderKind: "human",
          latestSenderHandle: "ada",
          latestSenderDescription: "",
          body: "@agent hi",
        },
      ],
      unreadSummary: { "#general": 1 },
      unreadConversationIds: {},
      snapshotMessages: [],
      openTasks: sampleOpenTasks,
      currentAttention: new Map(),
      seenDeliveryIds: new Set(),
      seenMessageIds: new Set(),
      alreadyRead: () => false,
      alreadyNotified: () => false,
      decide: () => {},
    });
    expect(directPlan?.notice).toContain("#general");
    expect(directPlan?.notice).not.toContain("Open tasks currently assigned to you");
  });

  test("recoveryOf and mergeCarried carry openTasks across cold-start replay", () => {
    const context = recoveryOf({
      protocolMajor: 1,
      requestId: "req-1",
      workspaceId: "ws-1",
      computerId: "comp-1",
      agentId: "agent-1",
      provider: "codex",
      model: "gpt-5",
      reasoning: "medium",
      openTasks: sampleOpenTasks,
    });
    expect(context.openTasks).toEqual(sampleOpenTasks);
    const merged = mergeCarried(
      { recovery: { unreadSummary: { "#ops": 1 } } },
      { recovery: { openTasks: sampleOpenTasks } },
    );
    expect(merged.recovery?.openTasks).toEqual(sampleOpenTasks);
  });
});

describe("DaemonRuntime start openTasks integration", () => {
  test("startup turn lists openTasks when no unread messages are pending", async () => {
    const { runtime, inputs, connection } = await createRuntimeHarness();
    try {
      await runtime.handleAgentStart(
        baseStartIntent(connection, { sessionId: "native-1", openTasks: sampleOpenTasks }),
      );
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toContain("Open tasks currently assigned to you:");
      expect(inputs[0]).toContain("- #coforge:#12 [in_progress] Ship start open tasks");
      expect(inputs[0]).toContain("- …and 2 more: `coforge task list --mine`");
    } finally {
      await runtime.stop();
    }
  });

  test("summary-only unread recovery appends openTasks to catch-up notice", async () => {
    const { runtime, inputs, connection } = await createRuntimeHarness();
    try {
      await runtime.handleAgentStart(
        baseStartIntent(connection, {
          sessionId: "native-1",
          unreadSummary: { "#general": 4 },
          openTasks: sampleOpenTasks,
        }),
      );
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toContain("#general 4 new messages");
      expect(inputs[0]).toContain("- #coforge:#12 [in_progress] Ship start open tasks");
      expect(inputs[0]).toContain("After catching up:");
    } finally {
      await runtime.stop();
    }
  });

  test("resumePrompt takes precedence and does not inject a startup openTasks turn", async () => {
    const { runtime, inputs, connection } = await createRuntimeHarness();
    try {
      await runtime.handleAgentStart(
        baseStartIntent(connection, {
          sessionId: "native-1",
          resumePrompt: "Focus on incident #99 only.",
          openTasks: sampleOpenTasks,
        }),
      );
      expect(inputs).toEqual(["Focus on incident #99 only."]);
    } finally {
      await runtime.stop();
    }
  });

  test("introductionPrompt takes precedence over startup openTasks", async () => {
    const { runtime, inputs, connection } = await createRuntimeHarness();
    try {
      await runtime.handleAgentStart(
        baseStartIntent(connection, {
          introductionPrompt: "Introduce yourself in #general.",
          openTasks: sampleOpenTasks,
        }),
      );
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toContain("Introduce yourself in #general.");
      expect(inputs[0]).not.toContain("Open tasks currently assigned to you");
    } finally {
      await runtime.stop();
    }
  });

  test("already-running Agent ignores openTasks on a follow-up start", async () => {
    const { runtime, inputs, connection } = await createRuntimeHarness();
    try {
      await runtime.handleAgentStart(baseStartIntent(connection, { sessionId: "native-1" }));
      expect(inputs).toHaveLength(1);
      await runtime.handleAgentStart(
        baseStartIntent(connection, {
          requestId: "req-2",
          sessionId: "native-1",
          openTasks: sampleOpenTasks,
        }),
      );
      expect(inputs).toHaveLength(1);
    } finally {
      await runtime.stop();
    }
  });
});
