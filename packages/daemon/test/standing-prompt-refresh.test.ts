import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNTIME_PROVIDER,
  type AgentStartIntent,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeEvent, AgentSessionOptions, CodeAgentProvider } from "@lrm/coforge-anvil";
import { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import {
  formatStandingPromptUpdate,
  planStandingPromptRefresh,
  prependStandingPromptUpdate,
} from "#src/agent-runtime/standing-prompt-refresh";
import { createCodeAgentProvider } from "#src/code-agent/registry";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime, type DaemonConfig } from "#src/daemon-runtime/runtime";
import type { AgentInputQueue } from "#src/daemon-runtime/runtime-launch-intent";
import { standingPromptHash } from "#src/persistence/agent-standing-prompt-ledger";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { captureDaemonLogs } from "./log-capture";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "coforge-standing-prompt-refresh-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function noopCompletion() {
  return { resolve() {}, reject() {} };
}

test("shipped provider registry marks only Pi, Coforge, and OpenCode as natively refreshing standing prompt on resume", () => {
  const nativeRefresh: RuntimeProvider[] = [
    RUNTIME_PROVIDER.PI,
    RUNTIME_PROVIDER.COFORGE,
    RUNTIME_PROVIDER.OPENCODE,
  ];
  const needsResumeRefresh: RuntimeProvider[] = [
    RUNTIME_PROVIDER.CLAUDE_CODE,
    RUNTIME_PROVIDER.CODEX,
    RUNTIME_PROVIDER.ANTIGRAVITY,
    RUNTIME_PROVIDER.GROK,
    RUNTIME_PROVIDER.CURSOR,
    RUNTIME_PROVIDER.DROID,
    RUNTIME_PROVIDER.KIRO,
    RUNTIME_PROVIDER.DEVIN,
    RUNTIME_PROVIDER.DSH,
    RUNTIME_PROVIDER.COMMAND_CODE,
  ];

  for (const name of nativeRefresh) {
    expect(createCodeAgentProvider(name).standingPromptRefreshesOnResume).toBe(true);
  }
  for (const name of needsResumeRefresh) {
    expect(createCodeAgentProvider(name).standingPromptRefreshesOnResume).not.toBe(true);
  }
});

test("planStandingPromptRefresh decides none, baseline_unknown, unchanged, or inject", () => {
  const previous = {
    hash: standingPromptHash("v1 prompt"),
    bytes: 9,
    provider: "codex",
    sessionId: "sess-1",
    recordedAtMs: 1_000,
  };

  expect(
    planStandingPromptRefresh({
      instructions: "v2 prompt",
      resumeSessionId: undefined,
      refreshesOnResume: false,
      previous,
      nowMs: 5_000,
    }),
  ).toEqual({ action: "none" });

  expect(
    planStandingPromptRefresh({
      instructions: "v2 prompt",
      resumeSessionId: "sess-1",
      refreshesOnResume: true,
      previous,
      nowMs: 5_000,
    }),
  ).toEqual({ action: "none" });

  expect(
    planStandingPromptRefresh({
      instructions: "v2 prompt",
      resumeSessionId: "sess-1",
      refreshesOnResume: false,
      previous: undefined,
      nowMs: 5_000,
    }),
  ).toEqual({
    action: "baseline_unknown",
    currentHash: standingPromptHash("v2 prompt"),
  });

  expect(
    planStandingPromptRefresh({
      instructions: "v2 prompt",
      resumeSessionId: "sess-2",
      refreshesOnResume: false,
      previous,
      nowMs: 5_000,
    }),
  ).toEqual({
    action: "baseline_unknown",
    currentHash: standingPromptHash("v2 prompt"),
  });

  expect(
    planStandingPromptRefresh({
      instructions: "v1 prompt",
      resumeSessionId: "sess-1",
      refreshesOnResume: false,
      previous,
      nowMs: 5_000,
    }),
  ).toEqual({ action: "unchanged" });

  expect(
    planStandingPromptRefresh({
      instructions: "v2 prompt",
      resumeSessionId: "sess-1",
      refreshesOnResume: false,
      previous,
      nowMs: 5_000,
    }),
  ).toEqual({
    action: "inject",
    staleForMs: 4_000,
    previousHash: previous.hash,
    currentHash: standingPromptHash("v2 prompt"),
  });
});

test("prependStandingPromptUpdate merges into startup or prompt, and unshifts standalone ahead of delivery", () => {
  const startupQueue: AgentInputQueue = {
    closed: false,
    items: [{ kind: "startup", text: "You are back online.", completion: noopCompletion() }],
  };
  expect(prependStandingPromptUpdate(startupQueue, "updated rules")).toBe(true);
  expect(startupQueue.items).toHaveLength(1);
  expect(startupQueue.items[0]!.kind).toBe("startup");
  if (startupQueue.items[0]!.kind === "startup") {
    expect(startupQueue.items[0]!.text).toContain("<standing-prompt-update>");
    expect(startupQueue.items[0]!.text).toContain("updated rules");
    expect(startupQueue.items[0]!.text).toContain("You are back online.");
  }

  const promptQueue: AgentInputQueue = {
    closed: false,
    items: [{ kind: "prompt", text: "continue the PR", completion: noopCompletion() }],
  };
  expect(prependStandingPromptUpdate(promptQueue, "updated rules")).toBe(true);
  expect(promptQueue.items).toHaveLength(1);
  if (promptQueue.items[0]!.kind === "prompt") {
    expect(promptQueue.items[0]!.text).toStartWith(formatStandingPromptUpdate("updated rules"));
    expect(promptQueue.items[0]!.text).toEndWith("continue the PR");
  }

  const deliveryQueue: AgentInputQueue = {
    closed: false,
    items: [
      { kind: "startup", text: "You are back online.", completion: noopCompletion() },
      {
        kind: "delivery",
        message: {
          protocolMajor: 1,
          requestId: "r-1",
          messageId: "m-1",
          deliveryId: "d-1",
          sequence: 1,
          workspaceId: "w",
          conversationId: "c",
          agentId: "a",
          body: "hello",
          method: "agent:v1:message:deliver",
          target: "#general",
          mentionsAgent: true,
        },
        completion: noopCompletion(),
      },
    ],
  };
  expect(prependStandingPromptUpdate(deliveryQueue, "updated rules")).toBe(true);
  expect(deliveryQueue.items[0]!.kind).toBe("memory");
  if (deliveryQueue.items[0]!.kind === "memory") {
    expect(deliveryQueue.items[0]!.text).toContain("<standing-prompt-update>");
    expect(deliveryQueue.items[0]!.text).toContain("do not reply");
  }

  const closedQueue: AgentInputQueue = { closed: true, items: [] };
  expect(prependStandingPromptUpdate(closedQueue, "updated rules")).toBe(false);
});

async function createStandingPromptHarness(options: {
  provider: RuntimeProvider;
  refreshesOnResume?: boolean;
  lazySessionId?: boolean;
}) {
  const connection: DaemonConfig = {
    computerId: "computer-a",
    workspaceId: "workspace-a",
    workspaceRoot: join(tempDir, "workspaces"),
  };
  const stateDir = join(tempDir, "state");
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");

  const agentDir = agentWorkspaceDirectory(
    connection.workspaceRoot,
    connection.workspaceId,
    "agent-a",
  );
  await mkdir(agentDir, { recursive: true });

  let systemPromptText = "Rule v1: always answer in haiku.";
  const sessions: Array<{
    options: AgentSessionOptions;
    inputs: string[];
    reportLateSessionId?: () => Promise<void>;
  }> = [];

  const provider: CodeAgentProvider = {
    provider: options.provider,
    ...(options.refreshesOnResume ? { standingPromptRefreshesOnResume: true } : {}),
    async createAgentSession(sessionOptions) {
      const listeners = new Set<(event: AgentRuntimeEvent) => void>();
      const exitListeners = new Set<() => void>();
      const emit = (event: AgentRuntimeEvent) => {
        for (const listener of listeners) listener(event);
      };
      const sessionId = sessionOptions.sessionId ?? `native-${sessions.length + 1}`;
      const record: {
        options: AgentSessionOptions;
        inputs: string[];
        reportLateSessionId?: () => Promise<void>;
      } = {
        options: sessionOptions,
        inputs: [],
      };
      sessions.push(record);
      if (options.lazySessionId && !sessionOptions.sessionId) {
        record.reportLateSessionId = async () => {
          await sessionOptions.onSessionId?.(sessionId);
        };
      } else {
        await sessionOptions.onSessionId?.(sessionId);
      }
      return {
        hasLiveTurn: false,
        async sendMessage(text) {
          record.inputs.push(text);
          emit({ type: "text-delta", text: "ok" });
          emit({ type: "completed", status: "completed" });
        },
        async notify(text) {
          record.inputs.push(text);
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
            identity: {
              name: "agent-a",
              displayName: "Agent A",
              description: systemPromptText,
            },
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

  const intent = (overrides: Partial<AgentStartIntent> = {}): AgentStartIntent => ({
    protocolMajor: 1,
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "agent-a",
    requestId: "start-1",
    controlEpoch: 1,
    launchId: "launch-1",
    provider: options.provider,
    model: "default",
    modelProvider: "openai",
    reasoning: "balanced",
    ...overrides,
  });

  return {
    runtime,
    sessions,
    intent,
    setSystemPrompt(next: string) {
      systemPromptText = next;
    },
  };
}

test("resumed session injects <standing-prompt-update> once when standing instructions change, keeping the same session", async () => {
  const { result: h, records } = await captureDaemonLogs(async () => {
    const h = await createStandingPromptHarness({ provider: RUNTIME_PROVIDER.CODEX });
    try {
      await h.runtime.handleAgentStart(
        h.intent({ requestId: "start-1", controlEpoch: 1, launchId: "launch-1" }),
      );
      expect(h.sessions[0]!.inputs.join("\n")).not.toContain("<standing-prompt-update>");

      await h.runtime.stopAgent("agent-a");
      await h.runtime.handleAgentStart(
        h.intent({
          requestId: "start-2",
          controlEpoch: 2,
          launchId: "launch-2",
          sessionId: "native-1",
          sessionMode: "resume",
        }),
      );
      expect(h.sessions[1]!.options.sessionId).toBe("native-1");
      expect(h.sessions[1]!.inputs.join("\n")).not.toContain("<standing-prompt-update>");

      h.setSystemPrompt("Rule v2: cite exact line numbers.");
      await h.runtime.stopAgent("agent-a");
      await h.runtime.handleAgentStart(
        h.intent({
          requestId: "start-3",
          controlEpoch: 3,
          launchId: "launch-3",
          sessionId: "native-1",
          sessionMode: "resume",
        }),
      );
      expect(h.sessions[2]!.options.sessionId).toBe("native-1");
      expect(h.sessions[2]!.inputs[0]).toContain("<standing-prompt-update>");
      expect(h.sessions[2]!.inputs[0]).toContain("Rule v2: cite exact line numbers.");

      await h.runtime.stopAgent("agent-a");
      await h.runtime.handleAgentStart(
        h.intent({
          requestId: "start-4",
          controlEpoch: 4,
          launchId: "launch-4",
          sessionId: "native-1",
          sessionMode: "resume",
        }),
      );
      expect(h.sessions[3]!.inputs.join("\n")).not.toContain("<standing-prompt-update>");

      return h;
    } finally {
      await h.runtime.stop();
    }
  });

  expect(h.sessions).toHaveLength(4);
  expect(
    records.some(
      (r) =>
        r.properties.event === "agent.runtime.standing_prompt_stale" &&
        r.properties.action === "injected",
    ),
  ).toBe(true);
});

test("provider with standingPromptRefreshesOnResume skips injecting <standing-prompt-update>", async () => {
  const h = await createStandingPromptHarness({
    provider: RUNTIME_PROVIDER.PI,
    refreshesOnResume: true,
  });
  try {
    await h.runtime.handleAgentStart(
      h.intent({ requestId: "start-1", controlEpoch: 1, launchId: "launch-1" }),
    );
    h.setSystemPrompt("Rule v2 for Pi");
    await h.runtime.stopAgent("agent-a");
    await h.runtime.handleAgentStart(
      h.intent({
        requestId: "start-2",
        controlEpoch: 2,
        launchId: "launch-2",
        sessionId: "native-1",
        sessionMode: "resume",
      }),
    );
    expect(h.sessions[1]!.inputs.join("\n")).not.toContain("<standing-prompt-update>");
  } finally {
    await h.runtime.stop();
  }
});

test("lazy sessionId reported after fresh launch still binds baseline so next changed resume injects update", async () => {
  const h = await createStandingPromptHarness({
    provider: RUNTIME_PROVIDER.CLAUDE_CODE,
    lazySessionId: true,
  });
  try {
    await h.runtime.handleAgentStart(
      h.intent({ requestId: "start-1", controlEpoch: 1, launchId: "launch-1" }),
    );
    await h.sessions[0]!.reportLateSessionId?.();

    h.setSystemPrompt("Rule v2 for Claude Code");
    await h.runtime.stopAgent("agent-a");
    await h.runtime.handleAgentStart(
      h.intent({
        requestId: "start-2",
        controlEpoch: 2,
        launchId: "launch-2",
        sessionId: "native-1",
        sessionMode: "resume",
      }),
    );
    expect(h.sessions[1]!.inputs[0]).toContain("<standing-prompt-update>");
    expect(h.sessions[1]!.inputs[0]).toContain("Rule v2 for Claude Code");
  } finally {
    await h.runtime.stop();
  }
});
