import { afterAll, beforeAll, expect, test } from "bun:test";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { WORKSPACE_ASSISTANT_KIND } from "#src/features/agents/agent-system-kind";
import type { ForwardedMessageView } from "#src/features/conversations/message-forward";
import { WorkspaceAssistantCommands } from "#src/server/agents/workspace-assistant-commands.server";
import { actionCardViews } from "#src/server/conversations/action-card-views.server";
import { loadForwardSource } from "#src/server/conversations/message-forward-source.server";
import { attachForwardedAccess } from "#src/server/conversations/message-forward-view.server";
import { storeMessageBody } from "#src/server/conversations/message-references.server";
import { MESSAGE_NOT_VISIBLE } from "#src/server/conversations/agent-message-validation-error.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { findAgentScopedMessage } from "#src/server/db/repositories/agent-message-lookup.repositories.server";
import {
  connectionString,
  expectMissingForOutsiders,
  privateChannelFixture,
  type PrivateChannelFixture,
} from "./helpers/private-channel-fixture";

/**
 * Task #302: a message of a private channel is read only from inside it, by its id too. Someone
 * outside it who holds the id (from a link, a log, a forward) gets nothing through any entry that
 * takes one: an Agent's or a Workspace assistant's `message resolve`, a `#channel:id` reference, a
 * forward's source and its card, and an action card's view.
 */
let fixture: PrivateChannelFixture;
let extra: Awaited<ReturnType<typeof setUp>>;

/** An Agent in the private channel, one outside it, each person's Workspace assistant, and an
 * action card in the private channel and in a DM. */
async function setUp({ db, ws, suffix, people, closed, direct }: PrivateChannelFixture) {
  const computer = await db.computer.create({
    data: { ownerId: people.insider, machineId: crypto.randomUUID() },
  });
  const agent = (name: string, ownerId: string) =>
    db.agent.create({
      data: {
        workspaceId: ws,
        ownerId,
        computerId: computer.id,
        name: `${name}${suffix}`,
        displayName: name,
        runtimeConfig: {},
      },
    });
  const scout = await agent("scout", people.insider);
  const stranger = await agent("stranger", people.outsider);
  const { members } = await db.conversation.update({
    where: { id: closed.id },
    data: { members: { create: { agentId: scout.id } } },
    select: { members: { where: { agentId: scout.id }, select: { id: true } } },
  });

  await db.workspaceAssistant.create({ data: { workspaceId: ws } });
  const assistants = new Map<string, string>();
  for (const [name, userId] of Object.entries(people)) {
    const assistant = await db.agent.create({
      data: {
        workspaceId: ws,
        ownerId: userId,
        name: `${name}-assistant${suffix}`,
        displayName: name,
        visibility: "private",
        systemKind: WORKSPACE_ASSISTANT_KIND,
        runtimeConfig: {},
      },
    });
    await db.workspaceAssistantSession.create({
      data: { workspaceId: ws, userId, agentId: assistant.id },
    });
    assistants.set(userId, assistant.id);
  }

  // A card in the private channel, and one in the DM of the insider and the owner.
  const cardIn = async (conversationId: string, senderMemberId: string, sequence: number) => {
    const message = await db.message.create({
      data: { workspaceId: ws, conversationId, senderMemberId, sequence, body: "Create a channel" },
    });
    await db.actionCard.create({
      data: {
        messageId: message.id,
        conversationId,
        workspaceId: ws,
        kind: "channel:create",
        payload: { type: "channel:create", name: "plans-secret", description: "Q3 plans" },
        preparedByAgentId: scout.id,
      },
    });
    return message;
  };
  const card = await cardIn(closed.id, members[0]!.id, 4);
  const insiderDmSeat = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: direct.id, userId: people.insider },
  });
  const directCard = await cardIn(direct.id, insiderDmSeat.id, 2);
  return { computer, scout, stranger, assistants, card, directCard };
}

beforeAll(async () => {
  if (!connectionString) return;
  fixture = await privateChannelFixture(connectionString);
  extra = await setUp(fixture);
});
afterAll(async () => {
  if (!fixture) return;
  const { db, ws } = fixture;
  await db.actionCard.deleteMany({ where: { workspaceId: ws } });
  // The computer outlives its Workspace and keeps its owner, so it goes before the people.
  await db.workspace.delete({ where: { id: ws } });
  if (extra) await db.computer.delete({ where: { id: extra.computer.id } });
  await fixture.dispose();
});

test.skipIf(!connectionString)(
  "a Workspace assistant resolves a private message only for a member",
  async () => {
    const { db, ws, closed } = fixture;
    const commands = new WorkspaceAssistantCommands(db);
    // By its whole id: a short prefix of a UUIDv7 is shared by every row made in the same minute.
    const resolve = (userId: string) =>
      commands.resolve(
        { workspaceId: ws, agentId: extra.assistants.get(userId)! },
        closed.message.id,
      );
    await expectMissingForOutsiders(fixture, [["resolve", resolve]]);
    expect(JSON.stringify(await resolve(fixture.people.insider))).toContain(closed.message.body);
  },
);

test.skipIf(!connectionString)(
  "an Agent resolves a private message only from inside its channel",
  async () => {
    const { db, ws, closed } = fixture;
    const resolve = (agentId: string, anchor: string) =>
      findAgentScopedMessage(db, ws, agentId, anchor);
    // The answer an Agent gets for an id nobody has.
    await expect(resolve(extra.stranger.id, closed.message.id)).rejects.toThrow(
      MESSAGE_NOT_VISIBLE,
    );
    await expect(resolve(extra.scout.id, closed.message.id)).resolves.toMatchObject({
      id: closed.message.id,
    });
  },
);

test.skipIf(!connectionString)(
  "a reference into a private channel stays text for a non-member",
  async () => {
    const { db, ws, people, outsiders, open, closed } = fixture;
    const body = `see #${closed.name} and #${closed.name}:${closed.message.id}`;
    const store = (userId: string) =>
      db.$transaction((tx) =>
        storeMessageBody(
          tx,
          { workspaceId: ws, conversationId: open.id, reader: { userId } },
          body,
          { targets: [] },
        ),
      );
    for (const userId of outsiders) expect((await store(userId)).body).toBe(body);
    expect((await store(people.insider)).body).toBe(
      `see <@channel:${closed.id}:${closed.name}> and <@thread:${closed.id}:${closed.message.id}:${closed.name}>`,
    );
  },
);

test.skipIf(!connectionString)(
  "a Workspace assistant names in its person's DM the channels its person reads",
  async () => {
    const { db, ws, people, closed } = fixture;
    const repo = new PrismaDirectConversationRepository(db);
    const send = async (userId: string) => {
      const agentId = extra.assistants.get(userId)!;
      const dm = await db.conversation.create({
        data: {
          workspaceId: ws,
          directKey: agentDirectKey(userId, agentId),
          members: { create: [{ userId }, { agentId }] },
        },
      });
      return (await repo.sendAgentMessage(dm.id, agentId, `see #${closed.name}`)).body;
    };
    expect(await send(people.outsider)).toBe(`see #${closed.name}`);
    expect(await send(people.insider)).toBe(`see <@channel:${closed.id}:${closed.name}>`);
  },
);

test.skipIf(!connectionString)(
  "a non-member can neither forward a private message nor open its original",
  async () => {
    const { db, ws, people, outsiders, closed } = fixture;
    await expectMissingForOutsiders(fixture, [
      [
        "forward source",
        (userId) =>
          loadForwardSource(db, { workspaceId: ws, userId, messageId: closed.message.id }),
      ],
    ]);

    // A forward of it, posted where all can read: only a member may open the original, and no one
    // else learns the channel's current name.
    const forwarded: ForwardedMessageView = {
      sourceSenderHandle: "insider",
      sourceCreatedAt: closed.message.createdAt.toISOString(),
      sourceBody: closed.message.body,
      sourceConversation: { id: closed.id, name: "old-name" },
      sourceMessageId: closed.message.id,
      sourceAccessible: false,
    };
    const card = async (userId: string) =>
      (await attachForwardedAccess(db, ws, userId, [{ forwarded }]))[0]!.forwarded;
    for (const userId of outsiders)
      expect(await card(userId)).toMatchObject({
        sourceAccessible: false,
        sourceConversation: { name: "old-name" },
      });
    expect(await card(people.insider)).toMatchObject({
      sourceAccessible: true,
      sourceConversation: { name: closed.name },
    });
  },
);

test.skipIf(!connectionString)(
  "an action card's view goes only to someone who can read its channel",
  async () => {
    const { db, ws, people } = fixture;
    const { card, directCard } = extra;
    const views = async (userId: string) => [
      ...(await actionCardViews(db, ws, userId, [card.id, directCard.id])).keys(),
    ];
    expect(await views(people.outsider)).toEqual([]);
    // The owner is outside the private channel but in the DM.
    expect(await views(people.owner)).toEqual([directCard.id]);
    expect((await views(people.insider)).sort()).toEqual([card.id, directCard.id].sort());
    expect((await actionCardViews(db, ws, people.insider, [card.id])).get(card.id)).toMatchObject({
      kind: "channel:create",
      name: "plans-secret",
      description: "Q3 plans",
    });
  },
);
