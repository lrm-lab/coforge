import { expect, test } from "bun:test";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { quietCentrifugo } from "./helpers/fake-centrifugo";
import { mentionDeliverySetup, passThrough } from "./helpers/mention-delivery-fixture";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");

test("ordinary top-level messages follow channel notification preferences or go only to the coordinator", async () => {
  const t = await mentionDeliverySetup(connectionString);
  try {
    const sender = new SendDirectMessage(
      new PrismaDirectConversationRepository(t.db),
      passThrough,
      quietCentrifugo(),
    );
    const sendAsAgent = (agentId = t.bob.id) =>
      sender.executeFromAgent({
        idempotencyKey: crypto.randomUUID(),
        workspaceId: t.workspace.id,
        agentId,
        target: `#team-${t.suffix}`,
        body: "Ordinary update from an Agent",
      });
    const sendAsHuman = () => t.send("Ordinary update from a person");
    const recipients = async (messageId: string) =>
      (
        await t.db.agentMessageDelivery.findMany({
          where: { messageId },
          select: { agentId: true },
        })
      )
        .map(({ agentId }) => agentId)
        .sort();

    expect(await recipients((await sendAsHuman()).id)).toEqual(
      [t.bob.id, t.carol.id, t.dave.id].sort(),
    );
    expect(await recipients((await sendAsAgent()).id)).toEqual([t.carol.id, t.dave.id].sort());

    await t.db.conversationMember.updateMany({
      where: { conversationId: t.team.id, agentId: t.carol.id },
      data: { notificationLevel: "relevant" },
    });
    await t.db.conversationMember.updateMany({
      where: { conversationId: t.team.id, agentId: t.dave.id },
      data: { notificationLevel: "muted", channelMuted: true },
    });

    expect(await recipients((await sendAsHuman()).id)).toEqual([t.bob.id]);
    expect(await recipients((await sendAsAgent()).id)).toEqual([]);

    await t.db.conversation.update({
      where: { id: t.team.id },
      data: { coordinatorAgentId: t.carol.id },
    });

    expect(await recipients((await sendAsHuman()).id)).toEqual([t.carol.id]);
    expect(await recipients((await sendAsAgent(t.dave.id)).id)).toEqual([t.carol.id]);

    await t.db.conversation.update({
      where: { id: t.team.id },
      data: { coordinatorAgentId: t.bob.id },
    });

    expect(await recipients((await sendAsAgent()).id)).toEqual([]);
  } finally {
    await t.cleanup();
  }
});
