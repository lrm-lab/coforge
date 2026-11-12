import { expect, test } from "bun:test";
import { AGENT_MASCOTS } from "#src/features/agents/agent-mascot";
import { mascotStaticUrl } from "#src/features/agents/mascot-contract";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { setupAgentReplying } from "./helpers/agent-replying-fixture";

/**
 * Task #93 (Frank, with a screenshot): "Frank removed coforge-qa2 from this channel." drew the
 * removed, archived Agent as a letter on a square. The notice named it by member row, but the row
 * drew faces from the conversation's current members, and a member who has left is not one. The
 * server now ships the faces of the people a notice names with the message, read from their member
 * rows whether or not they left. Screenshots at 1440 and 390, light and dark, are written under
 * `.amp/e2e/archived-member-notice-avatar/`.
 */
const fx = setupAgentReplying({ artifactsName: "archived-member-notice-avatar" });
const { suffix, evaluate, until } = fx;

test("a notice about a removed, archived Agent draws its real avatar", async () => {
  const channelId = await fx.createChannel(`e2e-archived-notice-${suffix}`);
  // A mascot the Agent's id would not pick by itself, so a match is its own pick, not luck.
  const mascot = AGENT_MASCOTS[AGENT_MASCOTS.length - 1]!;
  const agent = await fx.db.agent.create({
    data: {
      workspaceId: fx.workspaceId,
      name: `e2e-gone-${suffix}`,
      displayName: `e2e-gone-${suffix}`,
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {},
      avatarMascot: mascot,
      deletedAt: new Date(),
    },
  });
  const [agentMember, frankMember] = await Promise.all([
    fx.db.conversationMember.create({
      data: {
        workspaceId: fx.workspaceId,
        conversationId: channelId,
        agentId: agent.id,
        leftAt: new Date(),
      },
    }),
    fx.db.conversationMember.findFirstOrThrow({
      where: { conversationId: channelId, userId: DEV_BROWSER_USER.id },
    }),
  ]);
  await fx.send(channelId, DEV_BROWSER_USER.id, `Before ${suffix}`);
  await fx.db.$transaction(async (tx) => {
    const sequence = await allocateSequence(tx, channelId);
    const message = await tx.message.create({
      data: {
        workspaceId: fx.workspaceId,
        conversationId: channelId,
        senderMemberId: null,
        sequence,
        body: `Frank removed @${agent.name} from this channel.`,
      },
    });
    await tx.systemMessage.create({
      data: {
        messageId: message.id,
        conversationId: channelId,
        workspaceId: fx.workspaceId,
        kind: "channel.member_removed",
        params: {
          members: [
            {
              memberId: agentMember.id,
              handle: agent.name,
              displayName: agent.name,
              kind: "agent",
            },
          ],
          actor: {
            memberId: frankMember.id,
            handle: DEV_BROWSER_USER.username,
            displayName: "Frank",
            kind: "user",
          },
        },
      },
    });
  });
  await fx.send(channelId, DEV_BROWSER_USER.id, `After ${suffix}`);

  const notice = `document.querySelector('[data-message="system"]')`;
  for (const [width, height] of [
    ["1440", "900"],
    ["390", "844"],
  ] as const) {
    await fx.browser("set", "viewport", width, height);
    await fx.open(channelId);
    await until(`!!${notice}`, 60_000);
    await evaluate(`${notice}.scrollIntoView({ block: "center" }) ?? true`);
    // Every face in the notice is a loaded picture, and the Agent's is its own mascot.
    await until(
      `[...${notice}.querySelectorAll("img[data-avatar-img]")].length === 2 && [...${notice}.querySelectorAll("img[data-avatar-img]")].every((img) => img.complete && img.naturalWidth > 0)`,
      30_000,
    );
    expect(
      await evaluate<boolean>(
        `[...${notice}.querySelectorAll("img[data-avatar-img]")].some((img) => img.src.endsWith(${JSON.stringify(mascotStaticUrl(mascot))}))`,
      ),
    ).toBe(true);
    await fx.browser("wait", "300");
    await fx.screenshot(`${width}.png`);
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await fx.browser("wait", "300");
    await fx.screenshot(`${width}-dark.png`);
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  }
}, 240_000);
