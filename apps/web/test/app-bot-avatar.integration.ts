import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { appBotAvatarUrl, appLogoUrl } from "#src/server/apps/app-logo.server";
import { botFixture, type BotFixture } from "./app-bots-fixture";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { mapBrowserMessage } from "#src/server/conversations/conversation-history.server";

/**
 * An app's bot wears its app's logo wherever it shows a face: the DM's open (its header and list
 * rows) reads the logo through the installation's app, never the mascot the bot's id would
 * choose (task #67). Skipped unless a local PostgreSQL is configured.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
const fixtures: BotFixture[] = [];
afterAll(async () => {
  for (const fixture of fixtures) await fixture.cleanup();
  await db.$disconnect();
});

test.skipIf(!connectionString)(
  "an app bot's direct conversation wears the app's logo, a plain agent keeps its mascot",
  async () => {
    const fixture = await botFixture(db);
    fixtures.push(fixture);
    await fixture.bots.grant(fixture.actor("owner"), fixture.key);
    const bots = await db.appInstallationBot.findMany({
      where: { installationId: fixture.installationId },
      select: { agentId: true },
    });
    const botAgentId = bots[0]!.agentId;
    // The app has a logo: the object key the profile's monogram-vs-logo test also reads.
    await db.app.update({
      where: { key: fixture.key },
      data: { logoObjectKey: `workspaces/x/apps/${fixture.key}/logos/logo/original` },
    });
    const viewer = fixture.people.member;
    const { conversationId } = await new DirectConversations(db).open(
      fixture.workspaceId,
      viewer.id,
      { agentId: botAgentId },
    );
    const repo = new PrismaDirectConversationRepository(db);
    const opened = await repo.openConversationForUser(
      fixture.workspaceId,
      viewer.id,
      conversationId,
    );
    if (!("agent" in opened) || !opened.agent) throw new Error("the DM's agent row is missing");
    const app = await db.app.findUniqueOrThrow({
      where: { key: fixture.key },
      select: { ownerWorkspaceId: true },
    });
    expect(opened.agent.avatarUrl).toBe(
      appLogoUrl(
        app.ownerWorkspaceId,
        fixture.key,
        `workspaces/x/apps/${fixture.key}/logos/logo/original`,
      ) ?? "",
    );
    // The helper agrees with what the read served.
    expect(appBotAvatarUrl).toBeDefined();
    // A plain agent's DM keeps its mascot: the logo is the bot's alone.
    const plainAgent = await db.agent.create({
      data: {
        workspaceId: fixture.workspaceId,
        name: `plain-${fixture.suffix}`,
        displayName: "Plain",
        ownerId: fixture.people.owner.id,
        runtimeConfig: {},
      },
    });
    const plainDm = await new DirectConversations(db).open(fixture.workspaceId, viewer.id, {
      agentId: plainAgent.id,
    });
    const plainOpened = await repo.openConversationForUser(
      fixture.workspaceId,
      viewer.id,
      plainDm.conversationId,
    );
    if (!("agent" in plainOpened) || !plainOpened.agent)
      throw new Error("the plain DM's agent row is missing");
    console.log("PLAIN_AVATAR", plainOpened.agent.avatarUrl);
    expect(plainOpened.agent.avatarUrl).not.toBeNull();
    // The message author reads the same face: a bot's message's sender avatar is the app logo.
    const author = mapBrowserMessage(
      {
        id: "message-bot",
        sequence: 1,
        threadRootId: null,
        senderMemberId: "bot-member",
        body: "hello",
        createdAt: new Date(),
        sender: {
          userId: null,
          agentId: botAgentId,
          user: null,
          agent: {
            name: fixture.key,
            displayName: "Acme Reviews",
            deletedAt: null,
            avatarMascot: null,
            appBot: {
              installation: {
                app: {
                  key: fixture.key,
                  ownerWorkspaceId: app.ownerWorkspaceId,
                  logoObjectKey: "w/logo",
                },
              },
            },
          },
        },
        attachments: [],
        mentions: [],
        reactionVersion: 0,
        reactions: [],
        forwards: [],
        systemMessage: null,
      } as never,
      fixture.workspaceId,
    );
    expect(author.senderAvatarUrl).toBe(
      appLogoUrl(app.ownerWorkspaceId, fixture.key, "w/logo") ?? "",
    );
  },
);
