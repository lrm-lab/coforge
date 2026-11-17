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
 * card's quiet "Don't answer" opens a small confirm popover ("Don't answer this question?" for one
 * question, "Don't answer these N questions?" for several; Chinese too); Escape and "Keep
 * answering" go back with nothing sent; "Don't answer" tells the Agent and the card in the stream
 * goes gray (`cancelled`, "You didn't answer") at the height it had, the message below it not
 * moving, with no way to take it back. On a phone the popover fits the screen; no sheet or dock
 * appears.
 *
 * The file keeps the name of the old ignore-and-undo fold; that fold (a card closing over a
 * transition and a 5-second Undo) no longer exists.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The Agent, channel and
 * cards are seeded per run and removed after it. Confirm and declined frames, desktop and phone,
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
  const zhChoice = await message(4, `Which plan in Chinese ${tail}`);
  const under = await message(5, "A message under the cards.");
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: 5 } });
  /** The message below each card, whose top must not move when the card is declined. */
  const below: Record<string, string> = {
    [choice.id]: questions.id,
    [questions.id]: phoneChoice.id,
    [phoneChoice.id]: zhChoice.id,
  };
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
      {
        messageId: zhChoice.id,
        conversationId: channel.id,
        workspaceId,
        kind: "choice",
        payload: choicePayload("Which plan should Chinese ship first?"),
        preparedByAgentId: agent.id,
      },
    ],
  });

  const card = (id: string) =>
    `document.querySelector('[data-message-id="${id}"] [data-question-card]')`;
  const state = (id: string) => `${card(id)}?.dataset.questionCard`;
  const decline = (id: string) => `[data-message-id="${id}"] [data-question-decline]`;
  const dialogWith = (title: string) =>
    `[...document.querySelectorAll('[role="dialog"]')].find((dialog) => dialog.textContent.includes(${JSON.stringify(title)}))`;
  const stored = (id: string) => db.actionCard.findUniqueOrThrow({ where: { messageId: id } });
  const open = async (waiting: string, locale = "en") => {
    await browser("open", `${origin}/${locale}/w/${workspace.slug}/channel/${channel.id}`);
    await waitFor(`${state(waiting)} === "pending" && ${pageHydrated}`, 60_000);
  };
  /** The card's height, where the message below it starts, how faded its prompt reads and its words. */
  const look = (id: string) =>
    evaluate<{ height: number; below: number; gray: string; text: string }>(`(() => {
      const el = ${card(id)};
      const prompt = el.querySelector("[data-question-prompt]") ?? el;
      let opacity = 1;
      for (let up = prompt; up; up = up.parentElement) {
        opacity *= Number(getComputedStyle(up).opacity);
        if (up === el) break;
      }
      const next = document.querySelector('[data-message-id="${below[id] ?? under.id}"]');
      return {
        height: el.getBoundingClientRect().height,
        below: next.getBoundingClientRect().top,
        gray: getComputedStyle(prompt).color + " / " + opacity,
        text: el.textContent,
      };
    })()`);
  /** True once the element stands where it stood at the last check: the stream has settled. */
  const still = (selector: string) =>
    `(() => { const box = document.querySelector('${selector}')?.getBoundingClientRect(); const at = box && box.top + "," + box.left; const same = !!box && window.__still === at; window.__still = at; return same; })()`;
  const historyOf = (id: string) => `${card(id)}.closest("[data-scroll-restoration-id]")`;
  const returningFocusAfterDeclineNeverScrollsTheConversation = async (id: string) => {
    const readingAt = await evaluate<number>(
      `(() => { const history = ${historyOf(id)}; const at = history.scrollTop; history.scrollTop = 0; return at; })()`,
    );
    await waitFor(`document.activeElement === ${card(id)}`);
    expect(await evaluate<number>(`${historyOf(id)}.scrollTop`)).toBe(0);
    await evaluate(`(${historyOf(id)}.scrollTop = ${readingAt}, true)`);
  };
  /** Asks to decline, backs out two ways (Escape, Keep answering), asks again and confirms. */
  const declineOnce = async (id: string, title: string, shot: string, moveOn = false) => {
    await waitFor(still(decline(id)));
    await browser("click", decline(id));
    await waitFor(`${dialogWith(title)} !== undefined`);
    expect(await evaluate<string>(`${dialogWith(title)}.textContent`)).toContain(
      `Decline Agent ${tail} will be told you declined, and you can't answer later.`,
    );
    await browser("press", "Escape");
    await waitFor(`${dialogWith(title)} === undefined`);
    expect((await stored(id)).state).toBe("pending");
    expect(await evaluate<string>(state(id))).toBe("pending");

    await browser("click", decline(id));
    await waitFor(`${dialogWith(title)} !== undefined`);
    await clickText('[role="dialog"] button', "Keep answering");
    await waitFor(`${dialogWith(title)} === undefined`);
    expect((await stored(id)).state).toBe("pending");
    expect(await evaluate<string>(state(id))).toBe("pending");

    await browser("click", decline(id));
    await waitFor(`${dialogWith(title)} !== undefined`);
    await browser("screenshot", join(artifacts, `${shot}-confirm.png`));
    await clickText('[role="dialog"] button', "Don't answer");
    if (moveOn) await returningFocusAfterDeclineNeverScrollsTheConversation(id);
    await waitFor(`${state(id)} === "cancelled"`);
    const declined = await stored(id);
    expect(declined.state).toBe("cancelled");
    expect(declined.committedByUserId).toBe(DEV_BROWSER_USER.id);
    await browser("screenshot", join(artifacts, `${shot}-declined.png`));
  };
  /** After a decline: gray at the height it had, the message below not moved, saying it was the
   * viewer's own decline, with nothing left to press and nothing to undo. */
  const expectDeclined = async (id: string, before: Awaited<ReturnType<typeof look>>) => {
    const after = await look(id);
    expect(after.height).toBe(before.height);
    expect(after.below).toBe(before.below);
    expect(after.gray).not.toBe(before.gray);
    expect(after.text).toContain("You didn't answer");
    expect(
      await evaluate<boolean>(
        `${card(id)}.querySelector("[data-question-send], [data-question-next], [data-question-decline], [data-question-other-input]") === null && document.querySelector("[data-ignore-undo]") === null`,
      ),
    ).toBe(true);
  };

  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "800");
    await open(choice.id);
    await evaluate(`(${card(choice.id)}.scrollIntoView({ block: "start" }), true)`);
    // A reader's own scroll, which a programmatic one is not: it ends following the latest, so the
    // stream does not return to the bottom when the card settles.
    const history = historyOf(choice.id);
    const scrolledFrom = await evaluate<number>(`${history}.scrollTop`);
    await browser("mouse", "move", "900", "300");
    await browser("mouse", "wheel", "-40");
    await waitFor(`${history}.scrollTop < ${scrolledFrom}`);
    await waitFor(still(decline(choice.id)));
    await waitFor(still(decline(choice.id)));

    // A choice card on a desktop: every waiting card has its own "Don't answer", the composer is
    // still there, and nothing else takes its place.
    const choiceBefore = await look(choice.id);
    expect(
      await evaluate<boolean>(
        `document.querySelectorAll("[data-question-decline]").length === 4 && document.querySelector("[data-composer]").getClientRects().length > 0`,
      ),
    ).toBe(true);
    await declineOnce(choice.id, "Don't answer this question?", "desktop-choice");
    await expectDeclined(choice.id, choiceBefore);
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("screenshot", join(artifacts, "desktop-choice-declined-dark.png"));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);

    // The questions card waiting below is declined the same way, its popover naming the count.
    await evaluate(`(${card(questions.id)}.scrollIntoView({ block: "start" }), true)`);
    const questionsBefore = await look(questions.id);
    await declineOnce(questions.id, "Don't answer these 2 questions?", "desktop-questions", true);
    await expectDeclined(questions.id, questionsBefore);

    // In Chinese the popover speaks Chinese, and "继续回答" goes back with nothing sent.
    await open(zhChoice.id, "zh-CN");
    await evaluate(`(${card(zhChoice.id)}.scrollIntoView({ block: "start" }), true)`);
    await browser("click", decline(zhChoice.id));
    await waitFor(`${dialogWith("不回答这个问题？")} !== undefined`);
    const zhDialog = await evaluate<{ text: string; buttons: string[] }>(
      `({ text: ${dialogWith("不回答这个问题？")}.textContent, buttons: [...${dialogWith("不回答这个问题？")}.querySelectorAll("button")].map((button) => button.textContent.trim()) })`,
    );
    expect(zhDialog.text).toContain(`Decline Agent ${tail} 会收到你不回答的消息，之后不能再答。`);
    expect(zhDialog.buttons).toEqual(["继续回答", "不回答"]);
    await clickText('[role="dialog"] button', "继续回答");
    await waitFor(`${dialogWith("不回答这个问题？")} === undefined`);
    expect((await stored(zhChoice.id)).state).toBe("pending");

    // A phone: the same "Don't answer" in the card, a popover that fits the screen, no sheet.
    await browser("set", "viewport", "390", "844");
    await open(phoneChoice.id);
    await evaluate(`(${card(phoneChoice.id)}.scrollIntoView({ block: "start" }), true)`);
    const phoneBefore = await look(phoneChoice.id);
    await browser("click", decline(phoneChoice.id));
    await waitFor(`${dialogWith("Don't answer this question?")} !== undefined`);
    expect(
      await evaluate<boolean>(`(() => {
        const box = ${dialogWith("Don't answer this question?")}.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth + 0.5;
      })()`),
    ).toBe(true);
    await browser("press", "Escape");
    await waitFor(`${dialogWith("Don't answer this question?")} === undefined`);
    await declineOnce(phoneChoice.id, "Don't answer this question?", "phone-choice");
    await expectDeclined(phoneChoice.id, phoneBefore);
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
