import { describe, expect, test } from "bun:test";
import { decodeAgentStartIntent, type AgentStartOpenTasks } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AgentControlPublisher } from "#src/server/agents/agent-control-publisher.server";
import type {
  AgentControlAgent,
  AgentControlState,
  AgentControlStore,
} from "#src/server/agents/agent-control-types.server";
import {
  boundStartOpenTaskTitle,
  readAgentStartOpenTasks,
} from "#src/server/db/repositories/agent-start-open-tasks.repositories.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { pendingRuntimeConfig } from "./helpers/agent-control-store";
import { recoverySecondPassStubs } from "./helpers/recovery-second-pass-stubs";

describe("readAgentStartOpenTasks", () => {
  test("returns undefined and skips count and conversation queries when the Agent has no open tasks", async () => {
    let countCalls = 0;
    let conversationCalls = 0;
    const db = {
      task: {
        findMany: async () => [],
        count: async () => {
          countCalls++;
          return 0;
        },
      },
      conversation: {
        findMany: async () => {
          conversationCalls++;
          return [];
        },
      },
    } as unknown as PrismaClient;

    expect(await readAgentStartOpenTasks(db, "ws-1", "agent-1")).toBeUndefined();
    expect(countCalls).toBe(0);
    expect(conversationCalls).toBe(0);
  });

  test("skips conversation lookup for channel-only tasks, renders mentions, and enforces scope", async () => {
    let conversationCalls = 0;
    let capturedArgs: Record<string, unknown> | undefined;
    const db = {
      task: {
        findMany: async (args: Record<string, unknown>) => {
          capturedArgs = args;
          return [
            {
              number: 12,
              title:
                "Ping <@human:11111111-1111-1111-1111-111111111111> and <@agent:22222222-2222-2222-2222-222222222222>",
              status: "in_progress",
              conversation: { id: "conv-ch", channelName: "coforge", directKey: null },
              message: {
                mentions: [
                  { kind: "user", actorId: "11111111-1111-1111-1111-111111111111", handle: "ada" },
                  {
                    kind: "agent",
                    actorId: "22222222-2222-2222-2222-222222222222",
                    handle: "scout",
                  },
                ],
              },
            },
          ];
        },
        count: async () => 1,
      },
      conversation: {
        findMany: async () => {
          conversationCalls++;
          return [];
        },
      },
    } as unknown as PrismaClient;

    const result = await readAgentStartOpenTasks(db, "ws-1", "agent-1");
    expect(result).toEqual({
      tasks: [{ ref: "#coforge:#12", title: "Ping @ada and @scout", status: "in_progress" }],
      more: 0,
    });
    expect(conversationCalls).toBe(0);
    expect(capturedArgs?.take).toBe(21);
    expect(capturedArgs?.orderBy).toEqual([
      { status: "asc" },
      { updatedAt: "desc" },
      { id: "desc" },
    ]);
    const where = capturedArgs?.where as Record<string, unknown>;
    expect(where.workspaceId).toBe("ws-1");
    expect(where.deletedAt).toBeNull();
    expect(where.owner).toEqual({ workspaceId: "ws-1", agentId: "agent-1" });
    expect(where.conversation).toBeDefined();
  });

  test("disambiguates human and agent DM task refs through directTargets", async () => {
    let countCalls = 0;
    const db = {
      task: {
        findMany: async () => [
          {
            number: 12,
            title: "Ship open tasks",
            status: "in_progress",
            conversation: { id: "conv-ch", channelName: "coforge", directKey: null },
            message: null,
          },
          {
            number: 3,
            title: "Review doc",
            status: "todo",
            conversation: { id: "conv-human-dm", channelName: null, directKey: null },
            message: null,
          },
          {
            number: 5,
            title: "Sync notes",
            status: "todo",
            conversation: {
              id: "conv-agent-dm",
              channelName: null,
              directKey: "agent:agent-1|agent:agent-2",
            },
            message: null,
          },
        ],
        count: async () => {
          countCalls++;
          return 3;
        },
      },
      conversation: {
        findMany: async () => [
          {
            id: "conv-human-dm",
            channelName: null,
            directKey: null,
            members: [{ user: { username: "ada" }, agent: null }],
          },
          {
            id: "conv-agent-dm",
            channelName: null,
            directKey: "agent:agent-1|agent:agent-2",
            members: [
              { user: null, agent: { id: "agent-1", name: "self" } },
              { user: null, agent: { id: "agent-2", name: "scout" } },
            ],
          },
        ],
      },
      agent: {
        findFirst: async () => ({ ownerId: "user-1", role: "member", systemKind: null }),
        findMany: async () => [
          {
            id: "agent-ada",
            name: "ada",
            visibility: "public",
            ownerId: "user-1",
            systemKind: null,
          },
        ],
      },
      user: {
        findMany: async () => [{ username: "scout" }],
      },
      workspaceMembership: {
        findUnique: async () => ({ role: "member" }),
      },
    } as unknown as PrismaClient;

    const result = await readAgentStartOpenTasks(db, "ws-1", "agent-1");
    expect(result).toEqual({
      tasks: [
        { ref: "#coforge:#12", title: "Ship open tasks", status: "in_progress" },
        { ref: "dm:@ada~human:#3", title: "Review doc", status: "todo" },
        { ref: "dm:@scout~agent:#5", title: "Sync notes", status: "todo" },
      ],
      more: 0,
    });
    expect(countCalls).toBe(0);
  });

  test("caps at 20 tasks and queries exact overflow count when more than 20 exist", async () => {
    let countCalls = 0;
    const rows = Array.from({ length: 21 }, (_, i) => ({
      number: i + 1,
      title: `Task ${i + 1}`,
      status: i < 5 ? "in_progress" : "todo",
      conversation: { id: "conv-ch", channelName: "coforge", directKey: null },
      message: null,
    }));
    const db = {
      task: {
        findMany: async () => rows,
        count: async () => {
          countCalls++;
          return 27;
        },
      },
    } as unknown as PrismaClient;

    const result = await readAgentStartOpenTasks(db, "ws-1", "agent-1");
    expect(result?.tasks).toHaveLength(20);
    expect(result?.tasks[0]).toEqual({
      ref: "#coforge:#1",
      title: "Task 1",
      status: "in_progress",
    });
    expect(result?.more).toBe(7);
    expect(countCalls).toBe(1);
  });

  test("boundStartOpenTaskTitle keeps 512 units and cuts safely before a trailing high surrogate", () => {
    const exact = "a".repeat(512);
    expect(boundStartOpenTaskTitle(exact)).toBe(exact);
    const over = "a".repeat(520);
    expect(boundStartOpenTaskTitle(over)).toBe(`${"a".repeat(511)}…`);
    const surrogateBoundary = `${"a".repeat(510)}🚀tail`;
    const bounded = boundStartOpenTaskTitle(surrogateBoundary);
    expect(bounded).toBe(`${"a".repeat(510)}…`);
    expect(bounded.length).toBeLessThanOrEqual(512);
  });
});

describe("recovery context and AgentControlPublisher openTasks propagation", () => {
  test("readAgentRecoveryContext attaches openTasks alongside unread state", async () => {
    const db = {
      agent: { findMany: async () => [] },
      $queryRaw: async () => [],
      ...recoverySecondPassStubs,
      task: {
        findMany: async () => [
          {
            number: 9,
            title: "Finish rollout",
            status: "in_progress",
            conversation: { id: "conv-ops", channelName: "ops", directKey: null },
            message: null,
          },
        ],
        count: async () => 1,
      },
    } as unknown as PrismaClient;

    const recovery = await new PrismaDirectConversationRepository(db).readAgentRecoveryContext(
      "ws-1",
      "agent-1",
    );
    expect(recovery.openTasks).toEqual({
      tasks: [{ ref: "#ops:#9", title: "Finish rollout", status: "in_progress" }],
      more: 0,
    });
  });

  test("AgentControlPublisher.sendStart encodes recovery.openTasks into AgentStartIntent", async () => {
    const published: Uint8Array[] = [];
    const store = {
      get: async () => undefined,
      replace: async () => true,
      memberRole: async () => "owner",
    } as unknown as AgentControlStore;
    const publisher = new AgentControlPublisher(
      store,
      {
        publish: async (_channel, data) => {
          published.push(data as Uint8Array);
        },
      },
      () => 1_700_000_000_000,
    );
    const openTasks: AgentStartOpenTasks = {
      tasks: [{ ref: "#coforge:#12", title: "Ship open tasks", status: "in_progress" }],
      more: 1,
    };
    const agent = {
      id: "agent-1",
      workspaceId: "ws-1",
      computerId: "comp-1",
      ownerId: "user-1",
      visibility: "public",
      runtimeConfig: pendingRuntimeConfig,
      state: null,
    } as unknown as AgentControlAgent;
    const state = {
      version: 1,
      protocolMajor: 1,
      requestId: "req-1",
      workspaceId: "ws-1",
      computerId: "comp-1",
      agentId: "agent-1",
      provider: "pi",
      epoch: 1,
      action: "start",
      phase: "starting",
      configRevision: "rev-1",
      launchId: "launch-1",
      controlSequence: 1,
      sessionSequence: 1,
    } as AgentControlState;

    const ok = await publisher.sendStart(agent, state, "launch-1", {
      recovery: { resumeMessages: [], unreadSummary: {}, openTasks },
    });
    expect(ok).toBe(true);
    expect(published).toHaveLength(1);
    const decoded = decodeAgentStartIntent(published[0]!);
    expect(decoded.openTasks).toEqual(openTasks);
  });
});
