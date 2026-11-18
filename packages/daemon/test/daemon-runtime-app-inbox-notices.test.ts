import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import type { DaemonConfig } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { sessionSpy } from "./fixtures/session-spy";
import { ManualClock } from "./fixtures/system-cleaner-harness";
import {
  REMINDER_DUE_MESSAGE_TYPE,
  type ReminderDue,
  type ReminderDueAckRequest,
} from "@lrm/coforge-sdk/internal";

const tempRoot = realpathSync(tmpdir());
const connection: DaemonConfig = {
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

  test("an item announced before a restart is not announced again", async () => {
    const stateDirectory = join(tempRoot, `coforge-inbox-restart-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const notices: string[] = [];
    const build = () =>
      new DaemonRuntime(
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

    const first = build();
    try {
      await first.start(connection);
      await first.mintAppItem("agent-a", {
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef: {
          kind: "reminder",
          id: "123e4567-e89b-42d3-a456-426614174000",
          revision: "1",
        },
        title: "Check the build",
        summary: "Reminder due",
      });
      await first.startAgent("agent-a", config);
      await Bun.sleep(10);
      expect(notices).toHaveLength(1);
      // A second idle transition announces nothing either: the item was told once.
      await first.drainAppInboxNotices("agent-a");
      expect(notices).toHaveLength(1);
    } finally {
      await first.stop();
    }

    const second = build();
    try {
      await second.start(connection);
      await second.startAgent("agent-a", config);
      await Bun.sleep(10);
      await second.drainAppInboxNotices("agent-a");
      expect(notices).toHaveLength(1);
    } finally {
      await second.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  test("a completed fenced Stop blocks a due reminder from waking the Agent", async () => {
    const stateDirectory = join(tempRoot, `coforge-inbox-stopped-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let sessions = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => {
          sessions++;
          return sessionSpy();
        },
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
      await runtime.handleAgentStart({
        protocolMajor: 1,
        requestId: "start-1",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-a",
        provider: "pi",
        model: "default",
        reasoning: "balanced",
        controlEpoch: 1,
        launchId: "launch-1",
      });
      await runtime.handleAgentStop({
        protocolMajor: 1,
        requestId: "stop-1",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-a",
        provider: "pi",
        controlEpoch: 2,
      });
      await runtime.mintAppItem("agent-a", {
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef: {
          kind: "reminder",
          id: "123e4567-e89b-42d3-a456-426614174000",
          revision: "1",
        },
        title: "Due",
        summary: "Reminder due",
      });
      await Bun.sleep(10);
      expect(sessions).toBe(1);
    } finally {
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
  test("a Due for an Agent under a fenced Stop is stored, acknowledged and kept in its inbox, without a wake", async () => {
    const stateDirectory = join(tempRoot, `coforge-due-stopped-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let sessions = 0;
    let receiveDue!: (due: ReminderDue) => void;
    const acks: ReminderDueAckRequest[] = [];
    const clock = new ManualClock();
    clock.nowMs = Date.now();
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => {
          sessions++;
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          onReminderDue(callback) {
            receiveDue = callback;
            return () => undefined;
          },
          async acknowledgeReminderDue(request) {
            acks.push(request);
            return true;
          },
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
      {},
      undefined,
      { clock },
    );
    try {
      await runtime.start(connection);
      await runtime.handleAgentStart({
        protocolMajor: 1,
        requestId: "start-1",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-a",
        provider: "pi",
        model: "default",
        reasoning: "balanced",
        controlEpoch: 1,
        launchId: "launch-1",
      });
      await runtime.handleAgentStop({
        protocolMajor: 1,
        requestId: "stop-1",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-a",
        provider: "pi",
        controlEpoch: 2,
      });
      const fireAt = new Date(Date.now() - 1000).toISOString();
      receiveDue({
        protocolMajor: 1,
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-a",
        occurrenceId: crypto.randomUUID(),
        job: {
          reminderId: "123e4567-e89b-42d3-a456-426614174000",
          ownerAgentId: "agent-a",
          version: 1,
          title: "Check the build",
          target: "@frank",
          messageId: "123e4567-e89b-42d3-a456-426614174001",
          fireAt,
        },
        expiresAt: new Date(Date.parse(fireAt) + 7 * 24 * 60 * 60_000).toISOString(),
        messageType: REMINDER_DUE_MESSAGE_TYPE,
      });
      const recordPath = join(
        stateDirectory,
        "reminder-due",
        connection.workspaceId,
        "agent-a",
        "occurrences.json",
      );
      const state = async () => {
        try {
          return (await Bun.file(recordPath).json()).occurrences[0]?.state;
        } catch {
          return undefined;
        }
      };
      const deadline = Date.now() + 5_000;
      while ((await state()) !== "delivered") {
        if (Date.now() > deadline) throw new Error("the Due was never delivered");
        await Bun.sleep(10);
      }
      await Bun.sleep(10);
      clock.advance(20 * 60_000);
      await Bun.sleep(10);
      expect(acks).toHaveLength(1);
      expect(sessions).toBe(1);
      const context = runtime.issueAgentContext("agent-a");
      const inbox = await runtime.inbox(context, {
        idempotencyKey: "check-stopped",
        context,
        operation: "check",
      });
      expect(inbox.entries.filter((entry) => entry.kind === "app")).toHaveLength(1);
    } finally {
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
  test("a running idle Agent whose reminder notice is rejected is told again a minute later", async () => {
    const stateDirectory = join(tempRoot, `coforge-due-renotify-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let receiveDue!: (due: ReminderDue) => void;
    const reminderNotices: string[] = [];
    const clock = new ManualClock();
    clock.nowMs = Date.now();
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({
          ...sessionSpy(),
          notify: async (notice) => {
            if (!/remind/i.test(notice)) return;
            reminderNotices.push(notice);
            if (reminderNotices.length === 1) throw new Error("notify rejected");
          },
        }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          onReminderDue(callback) {
            receiveDue = callback;
            return () => undefined;
          },
          async acknowledgeReminderDue() {
            return true;
          },
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async sendAgentDeliveryAck() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
      {},
      undefined,
      { clock },
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      const fireAt = new Date(clock.nowMs - 1000).toISOString();
      receiveDue({
        protocolMajor: 1,
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-a",
        occurrenceId: crypto.randomUUID(),
        job: {
          reminderId: "123e4567-e89b-42d3-a456-426614174000",
          ownerAgentId: "agent-a",
          version: 1,
          title: "Check the build",
          target: "@frank",
          messageId: "123e4567-e89b-42d3-a456-426614174001",
          fireAt,
        },
        expiresAt: new Date(Date.parse(fireAt) + 7 * 24 * 60 * 60_000).toISOString(),
        messageType: REMINDER_DUE_MESSAGE_TYPE,
      });
      const deadline = Date.now() + 5_000;
      while (reminderNotices.length < 1 && Date.now() < deadline) await Bun.sleep(10);
      await Bun.sleep(10);
      expect(reminderNotices).toHaveLength(1);
      clock.advance(60_000);
      while (reminderNotices.length < 2 && Date.now() < deadline) await Bun.sleep(10);
      expect(reminderNotices).toHaveLength(2);
      clock.advance(60 * 60_000);
      await Bun.sleep(10);
      expect(reminderNotices).toHaveLength(2);
    } finally {
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
