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
