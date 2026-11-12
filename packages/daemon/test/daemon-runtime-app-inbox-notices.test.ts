import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import type { WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { sessionSpy } from "./fixtures/session-spy";

const tempRoot = realpathSync(tmpdir());
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: join(tempRoot, `coforge-app-inbox-notices-${crypto.randomUUID()}`),
};
const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

describe("DaemonRuntime App Inbox notices", () => {
  test("a backlog of due reminders wakes the Agent with one merged notice", async () => {
    const stateDirectory = join(tempRoot, `coforge-inbox-merge-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const notices: string[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({
          ...sessionSpy(),
          notify: async (notice) => {
            notices.push(notice);
          },
        }),
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
          async agentMessage() {
            throw new Error("must not read cloud");
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    try {
      await runtime.start(connection);
      for (const [revision, title] of [
        ["1", "First"],
        ["2", "Second"],
        ["3", "Third"],
      ] as const)
        await runtime.mintAppItem("agent-a", {
          appId: "system.reminder",
          notificationClass: "due",
          sourceRef: {
            kind: "reminder",
            id: "123e4567-e89b-42d3-a456-426614174000",
            revision,
          },
          title,
          summary: "Reminder due",
        });
      await runtime.mintAppItem("agent-a", {
        appId: "system.cleaner",
        notificationClass: "memory_size",
        sourceRef: { kind: "memory_size", id: "agent-a", revision: "0" },
        title: "MEMORY.md is large",
        summary: "Trim it",
      });
      expect(notices).toEqual([]);
      await runtime.startAgent("agent-a", config);
      await Bun.sleep(10);
      // The three due reminders share one notice; the cleaner hint keeps the generic one, and
      // every item stays its own separately acknowledged App Inbox entry.
      expect(notices).toHaveLength(2);
      expect(notices[0]).toMatch(/^3 reminders due\. Earliest: /);
      expect(notices[0]).toEndWith(". Run coforge inbox check.");
      expect(notices[1]).toBe("New app item available. Run coforge inbox check.");
      const context = runtime.issueAgentContext("agent-a");
      const snapshot = await runtime.inbox(context, {
        idempotencyKey: "check",
        context,
        operation: "check",
      });
      expect(snapshot.entries.map((entry) => entry.kind)).toEqual(["app", "app", "app", "app"]);
      // Every item id was registered against the shared notice: a second drain repeats nothing.
      await runtime.drainAppInboxNotices("agent-a");
      expect(notices).toHaveLength(2);
    } finally {
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
