import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
 * Task #85 (Frank, 11-12): not answering a choice or questions card is a decline, asked once. The
 * dock's "Don't answer" opens a confirm popover over the dock; Escape and Cancel go back with
 * nothing sent; the confirm tells the Agent, turns the dock to its receipt, and the card in the
 * stream goes gray (`cancelled`, "You didn't answer") at the height it had, with no way to take it
 * back. On a desktop the button is in the dock's top bar, on a phone at the sheet's foot.
 *
 * The file keeps the name of the old ignore-and-undo fold; that fold (a card closing over a
 * transition and a 5-second Undo) no longer exists.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The Agent, channel and
 * cards are seeded per run and removed after it. Confirm and receipt frames, desktop and phone,
 * are written under `.amp/e2e/card-ignore-fold/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/card-ignore-fold");

test("Don't answer asks once, then sends the decline and grays the card", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor, clickText } = browserSession(
    browserPath,
    `card-decline-${process.pid}`,
  );
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-decline-${tail}`,
      displayName: `Decline Agent ${tail}`,
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
      channelName: `e2e-decline-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
    include: { members: true },
  });
  const agentMember = channel.members.find((member) => member.agentId === agent.id)!;
  const message = (sequence: number, body: string) =>
    db.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        sequence,
        senderMemberId: agentMember.id,
        body,
      },
    });
  const choice = await message(1, `Which plan ${tail}`);
  const questions = await message(2, `Two questions ${tail}`);
  const phoneChoice = await message(3, `Which plan on a phone ${tail}`);
  await message(4, "A message under the cards.");
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: 4 } });
  const options = (names: string[]) => names.map((label, index) => ({ id: `o${index}`, label }));
  const choicePayload = (prompt: string) => ({
    type: "choice",
    prompt,
    options: options(["Search in the header", "Saved filters", "Bulk actions"]),
    to: DEV_BROWSER_USER.id,
  });
  await db.actionCard.createMany({
    data: [
      {
        messageId: choice.id,
        conversationId: channel.id,
        workspaceId,
        kind: "choice",
        payload: choicePayload("Which plan should we ship first?"),
        preparedByAgentId: agent.id,
      },
      {
        messageId: questions.id,
        conversationId: channel.id,
        workspaceId,
        kind: "questions",
        payload: {
          type: "questions",
          prompt: "Before launch",
          questions: [
            {
              id: "region",
              prompt: "Which deploy region should we target?",
              select: "one",
              options: options(["US West", "EU Central", "Asia Pacific"]),
            },
            {
              id: "checks",
              prompt: "Which pre-release checks should run?",
              select: "many",
              options: options(["Unit tests", "End-to-end tests"]),
            },
          ],
          to: DEV_BROWSER_USER.id,
        },
        preparedByAgentId: agent.id,
      },
      {
        messageId: phoneChoice.id,
        conversationId: channel.id,
        workspaceId,
        kind: "choice",
        payload: choicePayload("Which plan should a phone ship first?"),
        preparedByAgentId: agent.id,
      },
    ],
  });

  const card = (id: string) =>
    `document.querySelector('[data-message-id="${id}"] [data-question-card]')`;
  const dock = "[data-question-dock]";
  const state = (id: string) => `${card(id)}?.dataset.questionCard`;
  /** The decline button the viewport shows: the top bar's on a desktop, the foot's on a phone. */
  const visibleDecline = `[...document.querySelectorAll("${dock} [data-dock-decline]")].find((button) => button.getClientRects().length > 0)`;
  const popover = `[...document.querySelectorAll("h2")].some((heading) => heading.textContent === "Don't answer?")`;
  const stored = (id: string) => db.actionCard.findUniqueOrThrow({ where: { messageId: id } });
  const press = async (expression: string) => {
    await evaluate(`(${expression}.setAttribute("data-e2e-press", ""), true)`);
    await browser("click", "[data-e2e-press]");
    await evaluate(
      `(document.querySelector("[data-e2e-press]")?.removeAttribute("data-e2e-press"), true)`,
    );
  };
  const open = async (waiting: string) => {
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}`);
    await waitFor(`${state(waiting)} === "pending" && ${pageHydrated}`, 60_000);
  };
  const openDock = async (id: string) => {
    await press(`document.querySelector('[data-message-id="${id}"] [data-question-card-answer]')`);
    await waitFor(`document.querySelector('${dock} [data-dock="answering"]') !== null`);
  };
  /** Asks to decline, backs out two ways (Escape, Cancel), asks again and confirms. */
  const decline = async (id: string, shot: string) => {
    await press(visibleDecline);
    await waitFor(popover);
    await browser("press", "Escape");
    await waitFor(
      `!(${popover}) && document.querySelector('${dock} [data-dock="answering"]') !== null`,
    );
    expect((await stored(id)).state).toBe("pending");

    await press(visibleDecline);
    await waitFor(popover);
    await clickText('[role="dialog"] button', "Cancel");
    await waitFor(`!(${popover})`);
    expect((await stored(id)).state).toBe("pending");
    expect(await evaluate<string>(state(id))).toBe("pending");

    await press(visibleDecline);
    await waitFor(popover);
    await browser("screenshot", join(artifacts, `${shot}-confirm.png`));
    await clickText('[role="dialog"] button', "Don't answer");
    await waitFor(
      `${state(id)} === "cancelled" && document.querySelector('${dock} [data-dock-receipt]') !== null`,
    );
    const declined = await stored(id);
    expect(declined.state).toBe("cancelled");
    expect(declined.committedByUserId).toBe(DEV_BROWSER_USER.id);
    await browser("screenshot", join(artifacts, `${shot}-declined.png`));
  };
  /** The card's height, its first line's colour and its words. */
  const look = (id: string) =>
    evaluate<{ height: number; color: string; text: string; answerable: boolean }>(`(() => {
      const el = ${card(id)};
      const prompt = el.querySelector("[data-question-row] span");
      return {
        height: el.getBoundingClientRect().height,
        color: getComputedStyle(prompt).color,
        text: el.textContent,
        answerable: el.querySelector("[data-question-card-answer]") !== null,
      };
    })()`);

  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "800");
    await open(choice.id);
    await evaluate(`(${card(choice.id)}.scrollIntoView({ block: "start" }), true)`);

    // A choice card on a desktop: the decline is in the dock's top bar, the only one in sight.
    const choiceBefore = await look(choice.id);
    expect(choiceBefore.answerable).toBe(true);
    await openDock(choice.id);
    expect(
      await evaluate<boolean>(
        `[...document.querySelectorAll("${dock} [data-dock-decline]")].filter((button) => button.getClientRects().length > 0).length === 1`,
      ),
    ).toBe(true);
    await decline(choice.id, "desktop-choice");
    // Gray in the stream at the height it had, saying it was the viewer's own decline, with
    // nothing left to press and nothing to undo.
    const choiceAfter = await look(choice.id);
    expect(choiceAfter.height).toBe(choiceBefore.height);
    expect(choiceAfter.color).not.toBe(choiceBefore.color);
    expect(choiceAfter.text).toContain("You didn't answer");
    expect(choiceAfter.answerable).toBe(false);
    expect(await evaluate<boolean>(`document.querySelector("[data-ignore-undo]") === null`)).toBe(
      true,
    );
    expect(
      await evaluate<boolean>(
        `document.querySelector('${dock} [data-dock-receipt]').textContent.includes("You didn't answer")`,
      ),
    ).toBe(true);
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("screenshot", join(artifacts, "desktop-choice-declined-dark.png"));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);

    // The receipt's next card is the questions card waiting below; it is declined the same way.
    await clickText(`${dock} button`, "Next");
    await waitFor(
      `document.querySelector('${dock} [data-dock="answering"] [data-dock-tab]') !== null`,
    );
    const questionsBefore = await look(questions.id);
    await decline(questions.id, "desktop-questions");
    const questionsAfter = await look(questions.id);
    expect(questionsAfter.height).toBe(questionsBefore.height);
    expect(questionsAfter.color).not.toBe(questionsBefore.color);
    expect(questionsAfter.text).toContain("You didn't answer");
    // Escape closes the dock even when focus has left it, as a refresh of the stream or a click
    // elsewhere leaves it (task #109).
    await evaluate(`(document.activeElement?.blur(), document.activeElement === document.body)`);
    await browser("press", "Escape");
    await waitFor(`document.querySelector('${dock}') === null`);

    // A phone: the decline sits at the sheet's foot, the top bar's is hidden.
    await browser("set", "viewport", "390", "844");
    await open(phoneChoice.id);
    await openDock(phoneChoice.id);
    expect(
      await evaluate<boolean>(`(() => {
        const [top, foot] = [...document.querySelectorAll("${dock} [data-dock-decline]")];
        return document.querySelector("${dock}").getAttribute("role") === "dialog"
          && top.getClientRects().length === 0 && foot.getClientRects().length > 0;
      })()`),
    ).toBe(true);
    await decline(phoneChoice.id, "phone-choice");
    expect(
      await evaluate<boolean>(`${card(phoneChoice.id)}.textContent.includes("You didn't answer")`),
    ).toBe(true);
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agentMessageDelivery
      .deleteMany({ where: { agentId: agent.id } })
      .catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
