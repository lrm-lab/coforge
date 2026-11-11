import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { devBrowserWorkspace } from "./helpers/browser-e2e";
import { chromePath, launchHeadlessChrome, until } from "./helpers/headless-chrome";

/**
 * Task #85 (Frank, 11-11): Ignore on a choice or questions card folds the card away as a dismissed
 * notification does, its height closing over a transition instead of in one frame, and Undo opens
 * it again the same way. With reduced motion it changes at once.
 *
 * Opt-in like the other browser E2Es: the real local Web and a headless Chrome over DevTools. The
 * Agent, channel and cards are seeded per run and removed after it. Light, dark and phone frames,
 * before, during and after, are written under `.amp/e2e/card-ignore-fold/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
const databaseUrl = Bun.env.DATABASE_URL;
const chrome = chromePath();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/card-ignore-fold");

/** The card's height on the frame before a press of `button` in it, then on every frame for
 * `ms` after, and whether a fold (a `grid-template-rows` transition) was running a frame after. */
const heightsAfterPress = (card: string, button: string, ms: number) => `(async () => {
  const card = ${card};
  const heights = [card.getBoundingClientRect().height];
  card.querySelector(${JSON.stringify(button)}).click();
  await new Promise((done) => requestAnimationFrame(done));
  const folding = card
    .getAnimations({ subtree: true })
    .some((a) => a.transitionProperty === "grid-template-rows" && a.playState === "running");
  heights.push(card.getBoundingClientRect().height);
  const start = performance.now();
  while (performance.now() - start < ${ms}) {
    await new Promise((done) => requestAnimationFrame(done));
    heights.push(card.getBoundingClientRect().height);
  }
  return { heights, folding };
})()`;
type Press = { heights: number[]; folding: boolean };

/** It got to `to` by a running fold, not in one frame (frames are not counted: a loaded runner
 * may draw a 150ms transition in one long frame). */
function expectFolded({ heights, folding }: Press, to: number) {
  expect(Math.abs(heights.at(-1)! - to), JSON.stringify(heights)).toBeLessThan(1);
  expect(folding, JSON.stringify(heights)).toBe(true);
}

test("Ignore folds a choice or questions card away and Undo opens it, at once with reduced motion", async () => {
  if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
    throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
  if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
    throw new Error("DATABASE_URL must target local PostgreSQL");
  if (!chrome) throw new Error("Chrome is required (COFORGE_E2E_CHROME)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-ignore-fold-${tail}`,
      displayName: `Fold Agent ${tail}`,
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
      channelName: `e2e-ignore-fold-${tail}`,
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
  await message(3, "A message under the cards.");
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: 3 } });
  const options = (names: string[]) => names.map((label, index) => ({ id: `o${index}`, label }));
  await db.actionCard.createMany({
    data: [
      {
        messageId: choice.id,
        conversationId: channel.id,
        workspaceId,
        kind: "choice",
        payload: {
          type: "choice",
          prompt: "Which plan should we ship first?",
          options: options(["Search in the header", "Saved filters", "Bulk actions"]),
          to: DEV_BROWSER_USER.id,
        },
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
    ],
  });

  const choiceCard = `document.querySelector('[data-message-id="${choice.id}"] [role="group"]')`;
  const questionsCard = `document.querySelector('[data-message-id="${questions.id}"] [data-questions-card]')`;
  const browser = await launchHeadlessChrome(chrome);
  let page!: Awaited<ReturnType<typeof browser.open>>;
  const shot = async (name: string) => {
    const { data } = await page.command<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    await Bun.write(join(artifacts, `${name}.png`), Buffer.from(data, "base64"));
  };
  const reducedMotion = (on: boolean) =>
    page.command("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "no-preference" }],
    });
  /** Switches the theme and waits out the colour transitions, so a frame shows one theme. */
  const theme = async (dark: boolean) => {
    await page.evaluate(`document.documentElement.classList.toggle("dark-mode", ${dark})`);
    await Bun.sleep(600);
  };
  const height = (card: string) => page.evaluate<number>(`${card}.getBoundingClientRect().height`);
  /** Ignores the choice card and holds the fold a little way in, for a frame of it moving. */
  const shotMidFold = async (name: string) => {
    await page.evaluate(`(async () => {
      ${choiceCard}.querySelector("[data-ignore]").click();
      await new Promise((done) => requestAnimationFrame(done));
      for (const animation of ${choiceCard}.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = 12;
      }
    })()`);
    await shot(name);
    await page.evaluate(
      `${choiceCard}.getAnimations({ subtree: true }).forEach((animation) => animation.finish())`,
    );
  };
  const undo = (card: string) =>
    page.evaluate(`${card}.querySelector("[data-ignore-undo]").click()`);
  /** Undone: the choice card's options take focus again, and the fold has had time to open. */
  const reopened = async (card: string) => {
    await until(() =>
      page.evaluate<boolean>(
        `[...${card}.querySelectorAll("[data-choice-row]")].every((row) => !row.closest("[inert]"))`,
      ),
    );
    await Bun.sleep(400);
  };
  const ready = (card: string) => `${card}?.querySelector("[data-ignore]") != null`;

  try {
    await mkdir(artifacts, { recursive: true });
    page = await browser.open(`${origin}/en/w/${workspace.slug}/channel/${channel.id}`);
    await page.command("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await reducedMotion(false);
    await until(
      () => page.evaluate<boolean>(`${ready(choiceCard)} && ${ready(questionsCard)}`),
      60_000,
    );
    await page.evaluate(`${choiceCard}.scrollIntoView({ block: "start" })`);

    // The frames first, so a run that fails below still shows what the fold looks like.
    for (const dark of [false, true]) {
      const name = dark ? "dark" : "light";
      await theme(dark);
      await shot(`desktop-${name}-1-before`);
      await shotMidFold(`desktop-${name}-2-folding`);
      await shot(`desktop-${name}-3-ignored`);
      await undo(choiceCard);
      await reopened(choiceCard);
    }
    await theme(false);

    // The choice card folds over a transition.
    const open = await height(choiceCard);
    const ignored = await page.evaluate<Press>(heightsAfterPress(choiceCard, "[data-ignore]", 400));
    const shut = ignored.heights.at(-1)!;
    expect(shut).toBeLessThan(open - 40);
    expectFolded(ignored, shut);
    // Folded, nothing in it takes focus; Undo is the way back.
    expect(
      await page.evaluate<boolean>(
        `[...${choiceCard}.querySelectorAll("[data-choice-row]")].every((row) => row.closest("[inert]"))`,
      ),
    ).toBe(true);
    // Undo opens it the same way, back to its height.
    expectFolded(
      await page.evaluate<Press>(heightsAfterPress(choiceCard, "[data-ignore-undo]", 400)),
      open,
    );

    // The questions card the same.
    const questionsOpen = await height(questionsCard);
    const questionsIgnored = await page.evaluate<Press>(
      heightsAfterPress(questionsCard, "[data-ignore]", 400),
    );
    const questionsShut = questionsIgnored.heights.at(-1)!;
    expect(questionsShut).toBeLessThan(questionsOpen - 40);
    expectFolded(questionsIgnored, questionsShut);
    await undo(questionsCard);
    await until(async () => Math.abs((await height(questionsCard)) - questionsOpen) < 1);

    // With reduced motion it is shut on the first frame, and open again on the first.
    await reducedMotion(true);
    const instant = await page.evaluate<Press>(heightsAfterPress(choiceCard, "[data-ignore]", 100));
    expect(instant.folding).toBe(false);
    expect(Math.abs(instant.heights[1]! - shut)).toBeLessThan(1);
    const back = await page.evaluate<Press>(
      heightsAfterPress(choiceCard, "[data-ignore-undo]", 100),
    );
    expect(Math.abs(back.heights[1]! - open)).toBeLessThan(1);
    await reducedMotion(false);

    // A phone, light and dark.
    await page.close();
    page = await browser.open(`${origin}/en/w/${workspace.slug}/channel/${channel.id}`, {
      phone: { width: 390, height: 844 },
    });
    await until(() => page.evaluate<boolean>(ready(choiceCard)), 60_000);
    await page.evaluate(`${choiceCard}.scrollIntoView({ block: "start" })`);
    for (const dark of [false, true]) {
      const name = dark ? "dark" : "light";
      await theme(dark);
      await shot(`phone-${name}-1-before`);
      await shotMidFold(`phone-${name}-2-folding`);
      await shot(`phone-${name}-3-ignored`);
      await undo(choiceCard);
      await reopened(choiceCard);
    }
    const phoneOpen = await height(choiceCard);
    const phoneIgnored = await page.evaluate<Press>(
      heightsAfterPress(choiceCard, "[data-ignore]", 400),
    );
    expect(phoneIgnored.heights.at(-1)!).toBeLessThan(phoneOpen - 40);
    expectFolded(phoneIgnored, phoneIgnored.heights.at(-1)!);
    await undo(choiceCard);
  } finally {
    await browser.close();
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agentMessageDelivery
      .deleteMany({ where: { agentId: agent.id } })
      .catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
