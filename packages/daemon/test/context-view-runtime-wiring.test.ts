import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_MESSAGE_METHOD, type AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { AgentContextViewService } from "#src/agent-context-view/agent-context-view-service";
import { forgetAgent } from "#src/daemon-runtime/forget-agent";
import {
  commitContextViewMessage,
  deliverContextViewMessage,
  reportContextViewAvailability,
  type ContextViewRuntimeDeps,
} from "#src/daemon-runtime/context-view-runtime-wiring";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "coforge-context-view-wiring-"));
  const transcript = join(
    root,
    "agent-context",
    "computer-1",
    "agent-1",
    "pi-requests",
    "session-1.jsonl",
  );
  mkdirSync(join(root, "agent-context", "computer-1", "agent-1", "pi-requests"), {
    recursive: true,
  });
  writeFileSync(transcript, '{"type":"request","id":"request-1"}\n', "utf8");
  const availability: unknown[] = [];
  const service = new AgentContextViewService({
    stateDirectory: root,
    serverId: "computer-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    reportAvailability: (value) => availability.push(value),
    now: () => 1_000,
  });
  const runtime = {
    config: { provider: "pi" },
    session: { contextViewRequestLogPath: transcript },
  };
  const deps: ContextViewRuntimeDeps = {
    service,
    enabled: new Map([["agent-1", true]]),
    runtime: () => runtime,
    restartConfig: () => undefined,
    workspaceRoot: root,
    stateDirectory: root,
    reported: () => ({ sessionId: "session-1" }),
  };
  return { root, transcript, deps, service, availability };
}

function delivery(): AgentMessageDelivery {
  return {
    protocolMajor: 1,
    requestId: "request-1",
    messageId: "message-1",
    deliveryId: "delivery-1",
    sequence: 1,
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    agentId: "agent-1",
    body: "hello",
    method: AGENT_MESSAGE_METHOD,
    features: { agentContextView: true },
  };
}

test("delivery commits a context-view index entry after the Agent writes its captured request", async () => {
  const fixtureValue = fixture();
  try {
    await deliverContextViewMessage(fixtureValue.deps, "agent-1", delivery(), async () => {
      writeFileSync(fixtureValue.transcript, '{"type":"response","id":"response-1"}\n', {
        encoding: "utf8",
        flag: "a",
      });
    });

    const entry = fixtureValue.service.find("agent-1", "message-1");
    expect(entry).toMatchObject({
      messageId: "message-1",
      sessionId: "session-1",
      transcript: "agent-context/computer-1/agent-1/pi-requests/session-1.jsonl",
    });
    expect(entry?.offset).toBe(statSync(fixtureValue.transcript).size);
    expect(readFileSync(fixtureValue.transcript, "utf8")).toContain('"response"');
  } finally {
    rmSync(fixtureValue.root, { recursive: true, force: true });
  }
});

test("launch session reporting publishes supported context-view availability from the same transcript seam", async () => {
  const fixtureValue = fixture();
  try {
    await reportContextViewAvailability(fixtureValue.deps, {
      agentId: "agent-1",
      provider: "pi",
      sessionId: "session-1",
    });
    expect(fixtureValue.availability).toMatchObject([
      {
        agentId: "agent-1",
        runtime: "pi",
        supported: true,
        trigger: "startup",
      },
    ]);
  } finally {
    rmSync(fixtureValue.root, { recursive: true, force: true });
  }
});

test("forgetting an Agent disables its indexed context view before local state is discarded", () => {
  const fixtureValue = fixture();
  try {
    commitContextViewMessage(fixtureValue.deps, "agent-1", delivery(), {
      absolute: fixtureValue.transcript,
      relative: "agent-context/computer-1/agent-1/pi-requests/session-1.jsonl",
    });
    expect(fixtureValue.service.find("agent-1", "message-1")).toBeDefined();

    forgetAgent(
      "agent-1",
      fixtureValue.deps.enabled,
      fixtureValue.service,
      { forgetAgent() {} } as never,
      { replaceOwnerSnapshot() {} } as never,
      { forget() {} } as never,
      { clearAgent() {} } as never,
      { remove() {} } as never,
      { forget() {} } as never,
      () => {},
    );

    expect(fixtureValue.deps.enabled.has("agent-1")).toBe(false);
    expect(fixtureValue.service.find("agent-1", "message-1")).toBeUndefined();
  } finally {
    rmSync(fixtureValue.root, { recursive: true, force: true });
  }
});

test("skips provider transcript lookup when context view is disabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-context-view-disabled-"));
  try {
    let locateCalls = 0;
    const service = new AgentContextViewService({
      stateDirectory: root,
      serverId: "computer-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      locateProviderTranscript: async () => {
        locateCalls += 1;
        return undefined;
      },
    });
    let reportedCalls = 0;
    const deps: ContextViewRuntimeDeps = {
      service,
      enabled: new Map([["agent-1", false]]),
      runtime: () => ({ config: { provider: "codex", envVars: { CODEX_HOME: root } } }),
      restartConfig: () => undefined,
      workspaceRoot: root,
      stateDirectory: root,
      reported: () => {
        reportedCalls += 1;
        return { sessionId: "019a1111-2222-3333-4444-555566667777" };
      },
    };
    const disabledDelivery = { ...delivery(), features: undefined };
    await deliverContextViewMessage(deps, "agent-1", disabledDelivery, async () => {});
    expect(locateCalls).toBe(0);
    expect(reportedCalls).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("caches a resolved provider transcript per session and invalidates on removal, session change, or disable", async () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-context-view-cache-"));
  try {
    const sessionA = "019a1111-2222-3333-4444-555566667777";
    const sessionB = "019a1111-2222-3333-4444-555566668888";
    const codexHome = join(root, "codex");
    const sessionDir = join(codexHome, "sessions", "2026", "11");
    mkdirSync(sessionDir, { recursive: true });
    const rolloutA = join(sessionDir, `rollout-2026-11-24T12-00-00-${sessionA}.jsonl`);
    const rolloutB = join(sessionDir, `rollout-2026-11-24T12-05-00-${sessionB}.jsonl`);

    let activeSession = sessionA;
    let locateCalls = 0;
    let currentRollout: string | undefined;
    const service = new AgentContextViewService({
      stateDirectory: root,
      serverId: "computer-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      locateProviderTranscript: async (_runtime, sessionId) => {
        locateCalls += 1;
        if (!currentRollout) return undefined;
        return {
          absolute: currentRollout,
          relative: `codex:sessions/2026/11/rollout-${sessionId}.jsonl`,
        };
      },
    });
    const deps: ContextViewRuntimeDeps = {
      service,
      enabled: new Map([["agent-1", true]]),
      runtime: () => ({ config: { provider: "codex", envVars: { CODEX_HOME: codexHome } } }),
      restartConfig: () => undefined,
      workspaceRoot: root,
      stateDirectory: root,
      reported: () => ({ sessionId: activeSession }),
    };

    await deliverContextViewMessage(
      deps,
      "agent-1",
      { ...delivery(), messageId: "m-miss" },
      async () => {},
    );
    expect(locateCalls).toBe(1);
    expect(service.find("agent-1", "m-miss")).toBeUndefined();

    writeFileSync(rolloutA, '{"type":"additional_tools"}\n', "utf8");
    currentRollout = rolloutA;
    await deliverContextViewMessage(
      deps,
      "agent-1",
      { ...delivery(), messageId: "m-1" },
      async () => {},
    );
    await deliverContextViewMessage(
      deps,
      "agent-1",
      { ...delivery(), messageId: "m-2" },
      async () => {},
    );
    expect(locateCalls).toBe(2);
    expect(service.find("agent-1", "m-1")?.sessionId).toBe(sessionA);
    expect(service.find("agent-1", "m-2")?.sessionId).toBe(sessionA);

    rmSync(rolloutA);
    writeFileSync(rolloutB, '{"type":"additional_tools"}\n', "utf8");
    currentRollout = rolloutB;
    await deliverContextViewMessage(
      deps,
      "agent-1",
      { ...delivery(), messageId: "m-3" },
      async () => {},
    );
    expect(locateCalls).toBe(3);
    expect(service.find("agent-1", "m-3")).toBeDefined();

    activeSession = sessionB;
    await deliverContextViewMessage(
      deps,
      "agent-1",
      { ...delivery(), messageId: "m-4" },
      async () => {},
    );
    expect(locateCalls).toBe(4);
    expect(service.find("agent-1", "m-4")?.sessionId).toBe(sessionB);

    service.disable("agent-1");
    service.enable("agent-1");
    await deliverContextViewMessage(
      deps,
      "agent-1",
      { ...delivery(), messageId: "m-5" },
      async () => {},
    );
    expect(locateCalls).toBe(5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-checks enabled state after awaiting transcript discovery in reportContextViewAvailability", async () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-context-view-avail-race-"));
  try {
    const rollout = join(root, "rollout.jsonl");
    writeFileSync(rollout, '{"type":"additional_tools"}\n', "utf8");
    const availability: unknown[] = [];
    let releaseLocate!: (value: { absolute: string; relative: string } | undefined) => void;
    const service = new AgentContextViewService({
      stateDirectory: root,
      serverId: "computer-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      reportAvailability: (value) => availability.push(value),
      locateProviderTranscript: () =>
        new Promise((resolve) => {
          releaseLocate = resolve;
        }),
    });
    const deps: ContextViewRuntimeDeps = {
      service,
      enabled: new Map([["agent-1", true]]),
      runtime: () => ({ config: { provider: "codex", envVars: { CODEX_HOME: root } } }),
      restartConfig: () => undefined,
      workspaceRoot: root,
      stateDirectory: root,
      reported: () => ({ sessionId: "session-1" }),
    };

    const pending = reportContextViewAvailability(deps, {
      agentId: "agent-1",
      provider: "codex",
      sessionId: "session-1",
    });
    deps.enabled.set("agent-1", false);
    service.disable("agent-1");
    releaseLocate({ absolute: rollout, relative: "codex:sessions/rollout.jsonl" });
    await pending;

    expect(availability).toHaveLength(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guards provider transcript cache against disable and overlapping session lookups", async () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-context-view-cache-race-"));
  try {
    const rolloutA = join(root, "rollout-a.jsonl");
    const rolloutB = join(root, "rollout-b.jsonl");
    writeFileSync(rolloutA, '{"type":"additional_tools"}\n', "utf8");
    writeFileSync(rolloutB, '{"type":"additional_tools"}\n', "utf8");

    const pendingResolvers = new Map<
      string,
      (value: { absolute: string; relative: string } | undefined) => void
    >();
    let locateCalls = 0;
    const service = new AgentContextViewService({
      stateDirectory: root,
      serverId: "computer-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      locateProviderTranscript: (_runtime, sessionId) => {
        locateCalls += 1;
        return new Promise((resolve) => {
          pendingResolvers.set(`${sessionId}-${locateCalls}`, resolve);
        });
      },
    });
    const envVars = { CODEX_HOME: root };

    const first = service.resolveProviderTranscript("agent-1", "codex", "session-a", envVars);
    service.disable("agent-1");
    pendingResolvers.get("session-a-1")!({
      absolute: rolloutA,
      relative: "codex:sessions/rollout-a.jsonl",
    });
    await first;

    const afterDisable = service.resolveProviderTranscript(
      "agent-1",
      "codex",
      "session-a",
      envVars,
    );
    expect(locateCalls).toBe(2);
    const overlapping = service.resolveProviderTranscript("agent-1", "codex", "session-b", envVars);
    expect(locateCalls).toBe(3);

    pendingResolvers.get("session-b-3")!({
      absolute: rolloutB,
      relative: "codex:sessions/rollout-b.jsonl",
    });
    await overlapping;

    pendingResolvers.get("session-a-2")!({
      absolute: rolloutA,
      relative: "codex:sessions/rollout-a.jsonl",
    });
    await afterDisable;

    const cachedB = await service.resolveProviderTranscript(
      "agent-1",
      "codex",
      "session-b",
      envVars,
    );
    expect(locateCalls).toBe(3);
    expect(cachedB?.absolute).toBe(rolloutB);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
