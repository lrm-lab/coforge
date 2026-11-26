import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { readChannelCoordinationFromConversations } from "#src/server/conversations/channel-coordination.server";
import { directTargets } from "#src/server/db/repositories/agent-peer-direct.repositories.server";
import {
  conversationTarget,
  TARGET_CONVERSATION_SELECT,
} from "#src/server/db/repositories/direct-conversation-agent-message.server";

test("TARGET_CONVERSATION_SELECT avoids nested members take:2 N+1 and selects id and coordination fields", () => {
  expect("members" in TARGET_CONVERSATION_SELECT).toBe(false);
  expect("members" in TARGET_CONVERSATION_SELECT.taskDiscussionOf.select.conversation.select).toBe(
    false,
  );
  expect(TARGET_CONVERSATION_SELECT.id).toBe(true);
  expect(TARGET_CONVERSATION_SELECT.coordinatorAgentId).toBe(true);
  expect(TARGET_CONVERSATION_SELECT.hiddenFromWorkspaceAt).toBe(true);
});

test("directTargets runs 0 member queries for channels/attachments/app_events and 1 batched query for DMs and DM task discussions", async () => {
  const memberQueries: Array<Record<string, unknown>> = [];
  const db = {
    agent: { findMany: async () => [] },
    user: { findMany: async () => [] },
    workspaceMembership: { findMany: async () => [] },
    conversation: { findMany: async () => [] },
    app: { findMany: async () => [{ id: "app-1", key: "github" }] },
    conversationMember: {
      findMany: async (args: Record<string, unknown>) => {
        memberQueries.push(args);
        return [
          { conversationId: "dm-human", user: { username: "alice" }, agent: null },
          {
            conversationId: "dm-agent",
            user: null,
            agent: { id: "agent-peer", name: "builder" },
          },
          { conversationId: "dm-board", user: { username: "bob" }, agent: null },
        ];
      },
    },
  } as unknown as PrismaClient;

  const channelOnly = [
    {
      id: "ch-1",
      kind: null,
      channelName: "general",
      directKey: null,
      attachmentCommentThread: null,
      taskDiscussionOf: null,
    },
    {
      id: "att-1",
      kind: null,
      channelName: null,
      directKey: null,
      attachmentCommentThread: { attachmentId: "a-1" },
      taskDiscussionOf: null,
    },
    {
      id: "app-conv",
      kind: "app_events",
      channelName: null,
      directKey: "app:app-1|agent:agent-1",
      attachmentCommentThread: null,
      taskDiscussionOf: null,
    },
  ];
  const channelTargetOf = await directTargets(db, "ws-1", "agent-1", channelOnly);
  expect(memberQueries).toHaveLength(0);
  expect(conversationTarget(channelOnly[0]!, channelTargetOf)).toBe("#general");
  expect(conversationTarget(channelOnly[1]!, channelTargetOf)).toBe("attachment:a-1");
  expect(conversationTarget(channelOnly[2]!, channelTargetOf)).toBe("@app.github");

  const dmHuman = {
    id: "dm-human",
    kind: null,
    channelName: null,
    directKey: "user:u1|agent:agent-1",
    attachmentCommentThread: null,
    taskDiscussionOf: null,
  };
  const dmAgent = {
    id: "dm-agent",
    kind: null,
    channelName: null,
    directKey: "agent:agent-1|agent:agent-peer",
    attachmentCommentThread: null,
    taskDiscussionOf: null,
  };
  const dmTask = {
    id: "task-disc-1",
    kind: null,
    channelName: null,
    directKey: null,
    attachmentCommentThread: null,
    taskDiscussionOf: {
      number: 7,
      conversation: {
        id: "dm-board",
        kind: null,
        channelName: null,
        directKey: "user:u2|agent:agent-1",
        attachmentCommentThread: null,
      },
    },
  };

  const mixedTargetOf = await directTargets(db, "ws-1", "agent-1", [
    ...channelOnly,
    dmHuman,
    dmAgent,
    dmTask,
  ]);
  expect(memberQueries).toHaveLength(1);
  expect("take" in memberQueries[0]!).toBe(false);
  expect(conversationTarget(dmHuman, mixedTargetOf)).toBe("@alice");
  expect(conversationTarget(dmAgent, mixedTargetOf)).toBe("@builder");
  expect(conversationTarget(dmTask, mixedTargetOf)).toBe("@bob:#7");
});

test("readChannelCoordinationFromConversations executes 0 queries without coordinators and 1 member query with coordinators", async () => {
  let conversationQueries = 0;
  let memberQueries = 0;
  const db = {
    conversation: {
      findMany: async () => {
        conversationQueries += 1;
        return [];
      },
    },
    conversationMember: {
      findMany: async () => {
        memberQueries += 1;
        return [
          { conversationId: "ch-coord-self", agent: { id: "agent-1", name: "lead" } },
          { conversationId: "ch-coord-other", agent: { id: "agent-2", name: "ops" } },
          { conversationId: "ch-coord-mismatch", agent: { id: "agent-1", name: "lead" } },
        ];
      },
    },
  } as unknown as PrismaClient;

  const noCoord = await readChannelCoordinationFromConversations(db, "ws-1", "agent-1", [
    {
      id: "",
      channelName: "missing-id",
      coordinatorAgentId: null,
      hiddenFromWorkspaceAt: null,
    },
    {
      id: "ch-plain",
      channelName: "general",
      coordinatorAgentId: null,
      hiddenFromWorkspaceAt: null,
    },
    {
      id: "ch-hidden",
      channelName: "secret",
      coordinatorAgentId: null,
      hiddenFromWorkspaceAt: new Date(),
    },
    { id: "dm-1", channelName: null, coordinatorAgentId: null, hiddenFromWorkspaceAt: null },
  ]);
  expect(conversationQueries).toBe(0);
  expect(memberQueries).toBe(0);
  expect(noCoord.has("")).toBe(false);
  expect(noCoord.get("ch-plain")).toBe("[CoForge current channel role: member; coordinator=none]");
  expect(noCoord.has("ch-hidden")).toBe(false);
  expect(noCoord.has("dm-1")).toBe(false);

  const withCoord = await readChannelCoordinationFromConversations(db, "ws-1", "agent-1", [
    {
      id: "ch-coord-self",
      channelName: "eng",
      coordinatorAgentId: "agent-1",
      hiddenFromWorkspaceAt: null,
    },
    {
      id: "ch-coord-other",
      channelName: "ops",
      coordinatorAgentId: "agent-2",
      hiddenFromWorkspaceAt: null,
    },
    {
      id: "ch-coord-mismatch",
      channelName: "qa",
      coordinatorAgentId: "agent-3",
      hiddenFromWorkspaceAt: null,
    },
    {
      id: "ch-plain",
      channelName: "general",
      coordinatorAgentId: null,
      hiddenFromWorkspaceAt: null,
    },
  ]);
  expect(conversationQueries).toBe(0);
  expect(memberQueries).toBe(1);
  expect(withCoord.get("ch-coord-self")).toBe(
    "[CoForge current channel role: coordinator; coordinator=@lead]",
  );
  expect(withCoord.get("ch-coord-other")).toBe(
    "[CoForge current channel role: member; coordinator=@ops]",
  );
  expect(withCoord.get("ch-coord-mismatch")).toBe(
    "[CoForge current channel role: member; coordinator=none]",
  );
  expect(withCoord.get("ch-plain")).toBe(
    "[CoForge current channel role: member; coordinator=none]",
  );
});
