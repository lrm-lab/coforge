import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { chromePath, launchHeadlessChrome, until } from "./helpers/headless-chrome";

/** A frame of the phone, for the delivery's before/after (task #91). */
async function shot(
  page: { command: <T>(method: string, params?: object) => Promise<T> },
  name: string,
) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dir = `${import.meta.dir}/../../../.amp/e2e/questions-card-phone`;
  await mkdir(dir, { recursive: true });
  const { data } = await page.command<{ data: string }>("Page.captureScreenshot", {});
  await writeFile(`${dir}/${name}.png`, Buffer.from(data, "base64"));
}
import { devBrowserWorkspace } from "./helpers/browser-e2e";

/**
 * Task #560 (Frank, 11-05, on his phone): a questions card on a phone, answered in the stream by
 * touch with no bottom sheet. Someone else's card names whom it waits on, shows its options
 * (a long recommended one wraps in the row's width, nothing ticked, a tap picks nothing) and its
 * pager turns; the viewer's own card is answered by touch inside itself (an option, which turns to
 * the next question, a tick on the many-pick one, Send) and ends as a summary of its answers.
 * Every option row is at least 48 px tall, a tap on the card never opens the message's action
 * sheet, and neither the page nor the card scrolls sideways, at 390 and at the narrowest phone,
 * 320.
 *
 * Opt-in like the other browser E2Es: the real local Web and a headless Chrome as a touch phone.
 * The people, Agent, channel and cards are seeded per run and removed after it. Frames are written
 * under `.amp/e2e/questions-card-phone/`.
 */
const LONG_OPTION = "Add a search icon to the header of all three pages";
const origin = Bun.env.COFORGE_E2E_WEB_URL;
const databaseUrl = Bun.env.DATABASE_URL;
const chrome = chromePath();

test("a questions card on a phone: looked through or answered in the stream, nothing scrolls sideways", async () => {
  if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
    throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
  if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
    throw new Error("DATABASE_URL must target local PostgreSQL");
  if (!chrome) throw new Error("Chrome is required (COFORGE_E2E_CHROME)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const asked = await db.user.create({
    data: { username: `e2e-card-phone-${tail}`, displayName: "Raft QA" },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-card-phone-${tail}`,
      displayName: `Card Phone Agent ${tail}`,
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
      channelName: `e2e-card-phone-${tail}`,
      description: "",
      members: {
        create: [{ userId: DEV_BROWSER_USER.id }, { userId: asked.id }, { agentId: agent.id }],
      },
    },
    include: { members: true },
  });
  const agentMember = channel.members.find((member) => member.agentId === agent.id)!;
  const asking = await db.message.create({
    data: {
      workspaceId,
      conversationId: channel.id,
      sequence: 1,
      senderMemberId: agentMember.id,
      body: `Two questions ${tail}`,
    },
  });
  const mine = await db.message.create({
    data: {
      workspaceId,
      conversationId: channel.id,
      sequence: 2,
      senderMemberId: agentMember.id,
      body: `Two questions for you ${tail}`,
    },
  });
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: 2 } });
  const labels = (names: string[], prefix: string) =>
    names.map((label, index) => ({ id: `${prefix}${index}`, label }));
  const payload = (to: string) => ({
    type: "questions",
    prompt: `Before launch ${tail}`,
    questions: [
      {
        id: "region",
        prompt: "Which deploy region should we target?",
        select: "one",
        options: [
          // Frank's card (11-11): a long recommended option with a description.
          {
            id: "r0",
            label: LONG_OPTION,
            description: "Next to the bell; it opens the same search",
            recommended: true,
          },
          { id: "r1", label: "US West" },
          { id: "r2", label: "EU Central" },
          { id: "r3", label: "Asia Pacific" },
          { id: "r4", label: "Middle East" },
        ],
      },
      {
        id: "checks",
        prompt: "Which pre-release checks should run?",
        select: "many",
        options: labels(["Unit tests", "End-to-end tests"], "c"),
      },
    ],
    to,
  });
  for (const [message, to] of [
    [asking, asked.id],
    [mine, DEV_BROWSER_USER.id],
  ] as const)
    await db.actionCard.create({
      data: {
        messageId: message.id,
        conversationId: channel.id,
        workspaceId,
        kind: "questions",
        payload: payload(to),
        preparedByAgentId: agent.id,
      },
    });

  const browser = await launchHeadlessChrome(chrome);
  let page!: Awaited<ReturnType<typeof browser.open>>;
  const card = (id: string) =>
    `document.querySelector('[data-message-id="${id}"] [data-question-card]')`;
  const scoped = (id: string, selector: string) => `[data-message-id="${id}"] ${selector}`;
  const onQuestion = (id: string, index: number) =>
    `${card(id)}?.dataset.questionAt === "${index}"`;
  const url = `${origin}/en/w/${workspace.slug}/channel/${channel.id}`;
  /** A tap as a finger makes it, at the middle of the element `selector` finds. */
  const tap = async (selector: string) => {
    await page.evaluate(
      `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`,
    );
    await Bun.sleep(150);
    const at = await page.evaluate<{ x: number; y: number }>(`(() => {
      const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    await page.command("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
    await page.command("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const wait = (expression: string) =>
    until(() => page.evaluate<boolean>(`Boolean(${expression})`));
  /** No sheet anywhere: not the old dock, not a message's action sheet. */
  const noSheet = () =>
    page.evaluate<boolean>(`document.querySelector("[data-message-actions-popover]") === null`);
  /** The page and the card of `id` stay inside the phone's width, every option row of the current
   * question is at least 48 px tall, the long recommended option wraps in its row (all of it on
   * screen, its tag after it), and the header names the channel without a `#`. */
  const expectCardFits = async (id: string, width: string) => {
    const fit = await page.evaluate<{
      pageFits: boolean;
      cardInside: boolean;
      sideways: boolean;
      shortest: number;
      wrapped: boolean;
      tag: boolean;
      header: string;
    }>(`(() => {
      const card = ${card(id)};
      const box = card.getBoundingClientRect();
      const rows = [...card.querySelectorAll("[data-question-option]")];
      const row = card.querySelector('[data-question-option="r0"]');
      return {
        pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        cardInside: box.left >= 0 && box.right <= innerWidth + 0.5,
        sideways: card.scrollWidth > card.clientWidth + 1,
        shortest: Math.min(...rows.map((option) => option.getBoundingClientRect().height)),
        wrapped: row.scrollWidth <= row.clientWidth + 1 && [...row.querySelectorAll("*")].every((el) => el.getBoundingClientRect().right <= row.getBoundingClientRect().right + 0.5),
        tag: row.textContent.includes(${JSON.stringify(LONG_OPTION)}) && row.textContent.includes("Recommended"),
        header: document.querySelector("[data-channel-name]").textContent,
      };
    })()`);
    expect(fit.pageFits, width).toBe(true);
    expect(fit.cardInside, width).toBe(true);
    expect(fit.sideways, width).toBe(false);
    expect(fit.shortest, width).toBeGreaterThanOrEqual(48);
    expect(fit.wrapped, width).toBe(true);
    expect(fit.tag, width).toBe(true);
    expect(fit.header.startsWith("#"), width).toBe(false);
  };
  /** Someone else's card: it names whom it waits on, shows its options with nothing ticked, and
   * its pager turns; there is no sheet to open. */
  const lookThrough = async (width: string) => {
    await until(
      () => page.evaluate<boolean>(`${card(asking.id)}?.dataset.questionCard === "pending"`),
      60_000,
    );
    expect(await page.evaluate<boolean>(`matchMedia("(pointer: coarse)").matches`)).toBe(true);
    const waiting = await page.evaluate<{
      text: string;
      right: number;
      answerable: boolean;
    }>(`(() => {
      const el = ${card(asking.id)};
      return {
        text: el.textContent,
        right: el.getBoundingClientRect().right,
        answerable: el.querySelector("[data-question-send], [data-question-other-input]") !== null,
      };
    })()`);
    expect(waiting.text, width).toContain("Waiting on Raft QA");
    expect(waiting.answerable, width).toBe(false);
    expect(waiting.right, width).toBeLessThanOrEqual(Number(width));
    await expectCardFits(asking.id, width);
    await shot(page, `look-through-${width}`);
    // A tap on an option picks nothing; the pager turns to the next question and back.
    await tap(scoped(asking.id, '[data-question-option="r1"]'));
    expect(
      await page.evaluate<boolean>(
        `[...${card(asking.id)}.querySelectorAll("[data-question-option]")].every((option) => option.getAttribute("aria-selected") !== "true")`,
      ),
      width,
    ).toBe(true);
    await tap(scoped(asking.id, 'button[data-question-page="next"]'));
    await wait(onQuestion(asking.id, 1));
    await tap(scoped(asking.id, 'button[data-question-page="prev"]'));
    await wait(onQuestion(asking.id, 0));
    expect(await noSheet(), width).toBe(true);
    expect(await page.evaluate<string>(`${card(asking.id)}.dataset.questionCard`), width).toBe(
      "pending",
    );
  };
  try {
    page = await browser.open(url, { phone: { width: 390, height: 844 } });
    await lookThrough("390");

    // The viewer's own card, answered by touch where it stands: a tap on the first question's
    // option ticks it and turns to the next question by itself, the many-pick question takes two
    // ticks, and Send ends in the summary.
    await until(
      () => page.evaluate<boolean>(`${card(mine.id)}?.dataset.questionCard === "pending"`),
      60_000,
    );
    await expectCardFits(mine.id, "390 own");
    await tap(scoped(mine.id, '[data-question-option="r1"]'));
    await wait(onQuestion(mine.id, 1));
    expect(await noSheet()).toBe(true);
    await tap(scoped(mine.id, '[data-question-option="c0"]'));
    await tap(scoped(mine.id, '[data-question-option="c1"]'));
    await wait(
      `${card(mine.id)}.querySelector('[data-question-option="c0"]').getAttribute("aria-selected") === "true" && ${card(mine.id)}.querySelector('[data-question-option="c1"]').getAttribute("aria-selected") === "true"`,
    );
    // Rows a thumb cannot miss: 48px tall, 6px apart.
    const rowBoxes = `[...${card(mine.id)}.querySelectorAll("[data-question-option]")].map((option) => option.getBoundingClientRect())`;
    expect(
      await page.evaluate<number>(`Math.min(...${rowBoxes}.map((box) => box.height))`),
    ).toBeGreaterThanOrEqual(48);
    expect(
      await page.evaluate<number>(
        `(() => { const boxes = ${rowBoxes}; return boxes.length < 2 ? 0 : Math.min(...boxes.slice(1).map((box, index) => box.top - boxes[index].bottom)); })()`,
      ),
    ).toBeGreaterThanOrEqual(5.5);
    await shot(page, "answering-many");
    await tap(scoped(mine.id, "button[data-question-send]"));
    await wait(`${card(mine.id)}?.dataset.questionCard === "executed"`);
    expect(await noSheet()).toBe(true);
    const sent = await db.actionCard.findUniqueOrThrow({ where: { messageId: mine.id } });
    expect(sent.state).toBe("executed");
    const answers = (
      sent.result as { answers: { questionId: string; selection: { optionId: string }[] }[] }
    ).answers;
    expect(
      answers.map((answer) => [answer.questionId, answer.selection.map((pick) => pick.optionId)]),
    ).toEqual([
      ["region", ["r1"]],
      ["checks", ["c0", "c1"]],
    ]);
    // The card settled in place: the page it was sent from keeps its picks marked, the pager
    // turns back to the first question's.
    const chosen = () =>
      page.evaluate<string[]>(
        `[...${card(mine.id)}.querySelectorAll("[data-question-option][data-chosen]")].map((row) => row.dataset.questionOption)`,
      );
    expect(await chosen()).toEqual(["c0", "c1"]);
    await tap(scoped(mine.id, 'button[data-question-page="prev"]'));
    await wait(
      `${card(mine.id)}.querySelector("[data-question-pager]").textContent.includes("1 / 2")`,
    );
    expect(await chosen()).toEqual(["r1"]);
    expect(
      await page.evaluate<boolean>(
        `document.documentElement.scrollWidth <= document.documentElement.clientWidth`,
      ),
    ).toBe(true);
    await shot(page, "answered");

    // The narrowest phone: the same, at 320.
    await page.close();
    page = await browser.open(url, { phone: { width: 320, height: 640 } });
    await lookThrough("320");
  } finally {
    await browser.close();
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agentMessageDelivery
      .deleteMany({ where: { agentId: agent.id } })
      .catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.workspaceMembership.deleteMany({ where: { userId: asked.id } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: asked.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
