import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * Task #552: on a phone a tap on a message opens its action sheet, but a tap on the words of a card
 * the viewer works (here a questions card) stays with the card: no sheet, the focus in the card,
 * and ← → turn its questions. A tap on a plain message still opens the sheet.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel, Agent and
 * messages are seeded per run and removed after it.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();

test("a tap on a card's words keeps the focus in the card on a phone", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `card-tap-${process.pid}`);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-card-tap-${tail}`,
      displayName: `Card Tap Agent ${tail}`,
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-card-tap-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
    include: { members: true },
  });
  const agentMember = channel.members.find((member) => member.agentId === agent.id)!;
  const plain = await db.message.create({
    data: {
      workspaceId,
      conversationId: channel.id,
      sequence: 1,
      senderMemberId: agentMember.id,
      body: `Plain words to tap ${tail}`,
    },
  });
  const asking = await db.message.create({
    data: {
      workspaceId,
      conversationId: channel.id,
      sequence: 2,
      senderMemberId: agentMember.id,
      body: `Two questions ${tail}`,
    },
  });
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: 2 } });
  await db.actionCard.create({
    data: {
      messageId: asking.id,
      conversationId: channel.id,
      workspaceId,
      kind: "questions",
      payload: {
        type: "questions",
        prompt: `Before launch ${tail}`,
        questions: [
          {
            id: "first",
            prompt: "Ship the sign-up page this week?",
            select: "one",
            options: [
              { id: "yes", label: "Yes" },
              { id: "no", label: "No" },
            ],
          },
          {
            id: "second",
            prompt: "Who announces it?",
            select: "one",
            options: [
              { id: "me", label: "Me" },
              { id: "you", label: "You" },
            ],
          },
        ],
        to: DEV_BROWSER_USER.id,
      },
      preparedByAgentId: agent.id,
    },
  });
  const card = `document.querySelector('[data-message-id="${asking.id}"] [data-questions-card]')`;
  const shown = (id: string) =>
    `${card}?.querySelector('[data-question="${id}"]:not([inert])') != null`;
  const sheet = `document.querySelector("[data-message-actions-popover]") != null`;
  try {
    // A phone: the shell below `lg` takes taps on a message as the way to its actions.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}`);
    await browser("wait", "--fn", `${pageHydrated} && ${shown("first")}`);

    await evaluate(
      `([...${card}.querySelectorAll('[data-question="first"] *')].find((el) => el.children.length === 0 && el.textContent === "Ship the sign-up page this week?").setAttribute("data-e2e", "words"), true)`,
    );
    await browser("click", '[data-e2e="words"]');
    await browser("wait", "300");
    expect(await evaluate<boolean>(sheet)).toBe(false);
    expect(await evaluate<boolean>(`${card}.contains(document.activeElement)`)).toBe(true);
    await browser("press", "ArrowRight");
    await browser("wait", "--fn", shown("second"));

    // The same tap on a plain message's words opens its actions.
    await evaluate(
      `([...document.querySelectorAll('[data-message-id="${plain.id}"] *')].find((el) => el.children.length === 0 && el.textContent.includes("Plain words to tap")).setAttribute("data-e2e", "plain"), true)`,
    );
    await browser("click", '[data-e2e="plain"]');
    await browser("wait", "--fn", sheet);
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agentMessageDelivery
      .deleteMany({ where: { agentId: agent.id } })
      .catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
