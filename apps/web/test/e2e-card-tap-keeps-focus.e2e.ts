import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

/**
 * Task #552: on a phone a tap on a message opens its action sheet, but a tap on the words of a
 * card the viewer works (here a questions card) stays with the card: each question is a row that
 * opens the dock at that question, no sheet, the focus inside the dock, and ← → turn its
 * questions however often, Escape closing the sheet after. A tap on the card's last line, its
 * gap, opens no sheet either. A tap on a plain message still opens the sheet.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel, Agent and
 * messages are seeded per run and removed after it.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();

test("a tap on a card's words keeps the focus in the card on a phone", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `card-tap-${process.pid}`);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
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
  const card = `document.querySelector('[data-message-id="${asking.id}"] [data-question-card]')`;
  const dock = "[data-question-dock]";
  const tabCurrent = (index: number) =>
    `document.querySelector('${dock} [data-dock-tab="${index}"]')?.getAttribute("aria-current") === "step"`;
  const sheet = `document.querySelector("[data-message-actions-popover]") != null`;
  try {
    // A phone: the shell below `lg` takes taps on a message as the way to its actions.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}`);
    await browser("wait", "--fn", `${pageHydrated} && ${card}?.dataset.questionCard === "pending"`);

    // A tap on the card's gap, the line under its questions, is the card's too: no action sheet.
    await evaluate(
      `(${card}.lastElementChild.firstElementChild.setAttribute("data-e2e", "gap"), true)`,
    );
    await browser("click", '[data-e2e="gap"]');
    await browser("wait", "400");
    expect(await evaluate<boolean>(sheet)).toBe(false);

    // A tap on a question's words opens the dock at that question, and no action sheet.
    await evaluate(
      `([...${card}.querySelectorAll('[data-question-row="first"] *')].find((el) => el.children.length === 0 && el.textContent === "Ship the sign-up page this week?").setAttribute("data-e2e", "words"), true)`,
    );
    await browser("click", '[data-e2e="words"]');
    await browser(
      "wait",
      "--fn",
      `document.querySelector('${dock} [data-dock="answering"]') != null`,
    );
    expect(await evaluate<boolean>(sheet)).toBe(false);
    await browser("wait", "--fn", tabCurrent(0));
    // The focus is in the dock, where ← → turn its questions.
    expect(
      await evaluate<boolean>(`document.querySelector('${dock}').contains(document.activeElement)`),
    ).toBe(true);
    await browser("press", "ArrowRight");
    await browser("wait", "--fn", tabCurrent(1));
    await browser("press", "ArrowLeft");
    await browser("wait", "--fn", tabCurrent(0));
    await browser("press", "ArrowRight");
    await browser("wait", "--fn", tabCurrent(1));
    expect(await evaluate<boolean>(sheet)).toBe(false);
    // Escape still closes the sheet after the turns.
    await browser("press", "Escape");
    await browser("wait", "--fn", `document.querySelector('${dock}') === null`);

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
