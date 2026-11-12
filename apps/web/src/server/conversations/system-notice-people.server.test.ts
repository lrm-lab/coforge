import { expect, test } from "bun:test";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { mapBrowserMessage, type BrowserMessageRow } from "./browser-message-projection.server";
import {
  noticeMemberIds,
  systemNoticeFaces,
  type SystemPersonFace,
} from "./system-notice-people.server";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const leftMember = "33333333-3333-4333-8333-333333333333";
const params = {
  members: [{ memberId: leftMember, handle: "qa2", displayName: "qa2", kind: "agent" }],
  actor: { memberId: null, handle: "frank", displayName: "Frank" },
};

test("the member ids a notice names are found wherever its people sit", () => {
  expect(noticeMemberIds(params)).toEqual([leftMember]);
  expect(noticeMemberIds({})).toEqual([]);
});

test("a notice naming an archived member who left resolves to that Agent's id and avatar", async () => {
  const queries: unknown[] = [];
  // The member row is read by id, so a `leftAt` row comes back like any other.
  const db = {
    conversationMember: {
      findMany: async (args: unknown) => {
        queries.push(args);
        return [
          {
            id: leftMember,
            userId: null,
            agentId,
            user: null,
            agent: { avatarMascot: "lime", appBot: null },
          },
        ];
      },
    },
  };
  const messages = [
    { systemMessage: { params } },
    { systemMessage: { params } },
    { systemMessage: null },
  ];
  const faces = await systemNoticeFaces(db as never, messages, workspaceId);
  // One query for the whole page, with each member once.
  expect(queries).toHaveLength(1);
  expect((queries[0] as { where: { id: { in: string[] } } }).where.id.in).toEqual([leftMember]);
  const expected: SystemPersonFace = {
    kind: "agent",
    id: agentId,
    avatarUrl: agentAvatarUrl(agentId, "lime"),
  };
  expect(faces.get(leftMember)).toEqual(expected);

  const view = mapBrowserMessage(
    {
      id: "m1",
      sequence: 1,
      threadRootId: null,
      senderMemberId: null,
      body: "Frank removed @qa2 from this channel.",
      createdAt: new Date(),
      attachments: [],
      sender: null,
      mentions: [],
      reactionVersion: 0,
      reactions: [],
      forwards: [],
      systemMessage: { kind: "channel.member_removed", params },
    } as unknown as BrowserMessageRow,
    workspaceId,
    undefined,
    faces,
  );
  expect(view.systemPeople).toEqual({ [leftMember]: expected });
});

test("a person with no member row is left to the directory", async () => {
  const db = { conversationMember: { findMany: async () => [] } };
  const faces = await systemNoticeFaces(db as never, [{ systemMessage: { params } }], workspaceId);
  expect(faces.size).toBe(0);
});
