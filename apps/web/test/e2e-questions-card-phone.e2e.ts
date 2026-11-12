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
 * Task #560 (Frank, 11-05, on his phone): a questions card on a phone. Someone else's card names
 * whom it waits on in its last line, and its row opens the dock as a bottom sheet to look through,
 * where a long recommended option wraps in the row's width; the viewer's own card is answered in
 * the sheet by touch (an option, Next, the review, Send) and ends as the receipt and an answered
 * card. Neither the page nor the sheet scrolls sideways, at 390 and at the narrowest phone, 320.
 *
 * Opt-in like the other browser E2Es: the real local Web and a headless Chrome as a touch phone.
 * The people, Agent, channel and cards are seeded per run and removed after it. Frames are written
 * under `.amp/e2e/questions-card-phone/`.
 */
const LONG_OPTION = "Add a search icon to the header of all three pages";
const origin = Bun.env.COFORGE_E2E_WEB_URL;
const databaseUrl = Bun.env.DATABASE_URL;
const chrome = chromePath();

test("a questions card on a phone: looked through or answered in a sheet, nothing scrolls sideways", async () => {
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
  const sheet = `document.querySelector('[data-question-dock]')`;
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
  /** A tap on the sheet's button whose text or name is `text`. */
  const tapButton = async (text: string) => {
    await page.evaluate(
      `([...${sheet}.querySelectorAll("button")].find((button) => button.textContent.trim() === ${JSON.stringify(text)} || button.getAttribute("aria-label") === ${JSON.stringify(text)}).setAttribute("data-e2e-tap", ""), true)`,
    );
    await tap("[data-e2e-tap]");
    await page.evaluate(
      `document.querySelector("[data-e2e-tap]")?.removeAttribute("data-e2e-tap")`,
    );
  };
  const inSheet = (expression: string) =>
    until(() => page.evaluate<boolean>(`${sheet} != null && (${expression})`));
  const option = (index: number) =>
    `[data-question-dock] [data-dock-page-current] [role="option"]:nth-child(${index})`;
  /** The page and the sheet stay inside the phone's width, the long recommended option wraps in
   * its row (all of it on screen, its tag after it), and the header names the channel without a
   * `#`. */
  const expectSheetFits = async (width: string) => {
    // The sheet has come up from the bottom edge.
    await until(() =>
      page.evaluate<boolean>(`Math.abs(${sheet}.getBoundingClientRect().bottom - innerHeight) < 2`),
    );
    const fit = await page.evaluate<{
      pageFits: boolean;
      sheetInside: boolean;
      bottomAligned: boolean;
      sideways: boolean;
      wrapped: boolean;
      tag: boolean;
      header: string;
    }>(`(() => {
      const sheet = ${sheet};
      const box = sheet.getBoundingClientRect();
      const row = sheet.querySelector('[data-dock-page-current] [role="option"]');
      const title = [...row.querySelectorAll("span")].find((el) => el.textContent.startsWith(${JSON.stringify(LONG_OPTION)}));
      const body = sheet.querySelector("[data-dock-page-current]").parentElement.parentElement;
      return {
        pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        sheetInside: box.left >= 0 && box.right <= innerWidth + 0.5,
        bottomAligned: Math.abs(box.bottom - innerHeight) < 2,
        sideways: body.scrollWidth > body.clientWidth + 1,
        wrapped: title.scrollWidth <= title.clientWidth + 1 && title.getBoundingClientRect().right <= row.getBoundingClientRect().right,
        tag: title.textContent.includes("Recommended"),
        header: document.querySelector("[data-channel-name]").textContent,
      };
    })()`);
    expect(fit.pageFits, width).toBe(true);
    expect(fit.sheetInside, width).toBe(true);
    expect(fit.bottomAligned, width).toBe(true);
    expect(fit.sideways, width).toBe(false);
    expect(fit.wrapped, width).toBe(true);
    expect(fit.tag, width).toBe(true);
    expect(fit.header.startsWith("#"), width).toBe(false);
  };
  /** Someone else's card: it names whom it waits on, and its row opens a sheet to look through. */
  const lookThrough = async (width: string) => {
    await until(
      () => page.evaluate<boolean>(`${card(asking.id)}?.dataset.questionCard === "pending"`),
      60_000,
    );
    expect(await page.evaluate<boolean>(`matchMedia("(pointer: coarse)").matches`)).toBe(true);
    const waiting = await page.evaluate<{ text: string; width: number; answer: boolean }>(`(() => {
      const el = ${card(asking.id)};
      return { text: el.textContent, width: el.getBoundingClientRect().right, answer: el.querySelector("[data-question-card-answer]") !== null };
    })()`);
    expect(waiting.text, width).toContain("Waiting on Raft QA");
    expect(waiting.answer, width).toBe(false);
    expect(waiting.width, width).toBeLessThanOrEqual(Number(width));
    await tap(`[data-message-id="${asking.id}"] [data-question-row="region"]`);
    await inSheet(
      `${sheet}.getAttribute("role") === "dialog" && ${sheet}.querySelector('[data-dock="viewing"]') != null`,
    );
    await expectSheetFits(width);
    // Nothing to pick, send or decline in a card that is not the viewer's.
    expect(
      await page.evaluate<boolean>(
        `["[data-dock-submit]", "[data-dock-other]", "[data-dock-decline]"].every((selector) => ${sheet}.querySelector(selector) === null)`,
      ),
    ).toBe(true);
    await shot(page, `look-through-${width}`);
    await tapButton("Close");
    await until(() =>
      page.evaluate<boolean>(`document.querySelector('[data-question-dock]') == null`),
    );
  };
  try {
    page = await browser.open(url, { phone: { width: 390, height: 844 } });
    await lookThrough("390");

    // The viewer's own card, answered by touch: Answer opens the sheet, an option is ticked, and
    // Next turns on; the review lists each question's answer, and Send ends in the receipt.
    await tap(`[data-message-id="${mine.id}"] [data-question-card-answer]`);
    await inSheet(`${sheet}.querySelector('[data-dock="answering"]') != null`);
    expect(
      await page.evaluate<boolean>(
        `${sheet}.getAttribute("role") === "dialog" && ${sheet}.querySelectorAll("[data-dock-decline]").length === 2`,
      ),
    ).toBe(true);
    await tap(option(2));
    await inSheet(
      `document.querySelector('${option(2)}').getAttribute("aria-selected") === "true"`,
    );
    await tapButton("Next");
    await inSheet(
      `${sheet}.querySelector('[data-dock-tab="1"]').getAttribute("aria-current") === "step"`,
    );
    await tap(option(1));
    await tap(option(2));
    await inSheet(
      `document.querySelector('${option(1)}').getAttribute("aria-selected") === "true" && document.querySelector('${option(2)}').getAttribute("aria-selected") === "true"`,
    );
    await shot(page, "answering-many");
    await tapButton("Next");
    await inSheet(
      `${sheet}.querySelector('[data-dock-tab="2"]').getAttribute("aria-current") === "step"`,
    );
    expect(
      await page.evaluate<string[][]>(
        `[...${sheet}.querySelectorAll('[data-dock-page-current] [role="option"]')].map((row) => [...row.children].map((el) => el.textContent.trim()))`,
      ),
    ).toEqual([
      ["Which deploy region should we target?", "US West"],
      ["Which pre-release checks should run?", "Unit tests, End-to-end tests"],
    ]);
    await shot(page, "review");
    await tap("[data-question-dock] [data-dock-submit]");
    await inSheet(`${sheet}.querySelector("[data-dock-receipt]") != null`);
    await shot(page, "receipt");
    await tapButton("Done");
    await until(() =>
      page.evaluate<boolean>(`document.querySelector('[data-question-dock]') == null`),
    );
    await until(() =>
      page.evaluate<boolean>(`${card(mine.id)}?.dataset.questionCard === "executed"`),
    );
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
    expect(await page.evaluate<string>(`${card(mine.id)}.textContent`)).toContain(
      "Unit tests, End-to-end tests",
    );

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
