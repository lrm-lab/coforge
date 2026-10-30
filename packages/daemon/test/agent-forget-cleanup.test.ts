import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionSpy } from "./fixtures/session-spy";
import type { WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { DaemonRuntime, InMemoryDaemonCredentialStore } from "@lrm/coforge-daemon";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

const workspaceRoot = await mkdtemp(join(tmpdir(), "coforge-forget-"));
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};
const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

/** A runtime whose workspace-delete handler is captured so the test can invoke it like the
 * Agent API would. */
async function setup(stateDirectory: string) {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  let deleteWorkspace:
    | ((request: import("@lrm/coforge-sdk/internal").AgentWorkspaceDeleteRequest) => Promise<void>)
    | undefined;
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      createAgentSession: async () => ({ ...sessionSpy(), notify: async () => {} }),
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
        onWorkspaceDelete(handler) {
          deleteWorkspace = handler;
          return () => {};
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    stateDirectory,
  );
  await runtime.start(connection);
  return {
    runtime,
    deleteAgent: (agentId: string) =>
      deleteWorkspace?.({
        protocolMajor: 1,
        requestId: `delete-${agentId}`,
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId,
      }),
  };
}

const checkInbox = (runtime: DaemonRuntime, agentId: string) =>
  runtime.inbox(runtime.issueAgentContext(agentId), {
    idempotencyKey: crypto.randomUUID(),
    context: runtime.issueAgentContext(agentId),
    operation: "check",
  });

test("deleting an Agent forgets its cursor ledger, attention state, and App Inbox", async () => {
  const stateDirectory = join(workspaceRoot, `state-${crypto.randomUUID()}`);
  const { runtime, deleteAgent } = await setup(stateDirectory);
  try {
    await runtime.startAgent("agent-a", config);
    // A delivered message leaves both attention state (a message_target entry) and the consumed
    // cursor's state database on disk; a minted transient App item lives only in the open inbox.
    await runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "delivery-1",
      messageId: "message-1",
      deliveryId: "delivery-1",
      sequence: 1,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-a",
      agentId: "agent-a",
      body: "hello",
      method: "agent:v1:message:deliver",
      target: "@ada",
    });
    await runtime.mintAppItem("agent-a", {
      appId: "system.reminder",
      notificationClass: "due",
      title: "Due",
      summary: "Now",
      sourceRef: { kind: "reminder", id: "123e4567-e89b-42d3-a456-426614174000", revision: "1" },
    });
    // A transient item lives only in the open inbox: a forgotten inbox cannot offer it again.
    await runtime.mintAppItem("agent-a", {
      appId: "system.cleaner",
      notificationClass: "disk_space",
      title: "Disk",
      summary: "Full",
      sourceRef: { kind: "disk_space", id: "agent-a", revision: "1" },
    });
    const context = runtime.issueAgentContext("agent-a");
    const before = await runtime.inbox(context, {
      idempotencyKey: "check-before",
      context,
      operation: "check",
    });
    expect(before.entries.map((entry) => entry.kind).sort()).toEqual([
      "app",
      "app",
      "message_target",
    ]);
    expect(existsSync(join(stateDirectory, "agent-state", "agent-a"))).toBe(true);

    await deleteAgent("agent-a");

    // The cursor ledger is gone with the Agent — an Agent that moves back starts a fresh read
    // cursor instead of resurrecting the pre-move frontier.
    expect(existsSync(join(stateDirectory, "agent-state", "agent-a"))).toBe(false);
    // Attention and the open App Inbox are forgotten too: the transient hint cannot resurface,
    // and the held message_target is gone. What was explicitly durable — the reminder item — is
    // re-read from disk, unchanged.
    const contextAfter = runtime.issueAgentContext("agent-a");
    const after = await runtime.inbox(contextAfter, {
      idempotencyKey: "check-after",
      context: contextAfter,
      operation: "check",
    });
    expect(
      after.entries.map((entry) =>
        entry.kind === "app" ? entry.app.notificationClass : entry.kind,
      ),
    ).toEqual(["due"]);

    // An Agent that moves back gets no old cursor: a re-delivered first sequence is fresh
    // attention again, not a silent "already consumed".
    await runtime.startAgent("agent-a", config);
    await runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "delivery-2",
      messageId: "message-1",
      deliveryId: "delivery-2",
      sequence: 1,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-a",
      agentId: "agent-a",
      body: "hello",
      method: "agent:v1:message:deliver",
      target: "@ada",
    });
    const contextBack = runtime.issueAgentContext("agent-a");
    const back = await runtime.inbox(contextBack, {
      idempotencyKey: "check-back",
      context: contextBack,
      operation: "check",
    });
    expect(back.entries.some((entry) => entry.kind === "message_target")).toBe(true);
  } finally {
    await runtime.stop();
  }
});
