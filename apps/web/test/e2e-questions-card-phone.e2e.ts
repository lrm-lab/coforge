import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { chromePath, launchHeadlessChrome, until } from "./helpers/headless-chrome";

/**
 * Task #560 (Frank, 11-05, on his phone): a questions card waiting on someone else. Its "Waiting
 * for" line names them as an @mention chip (task #563); the ← → that turn its questions are
 * pressable 44px squares under a finger; the next question shows its edge at the right, a swipe
 * turns to it, and the card is as tall on every question (task #535).
 *
 * Opt-in like the other browser E2Es: the real local Web and a headless Chrome as a touch phone.
 * The people, Agent, channel and card are seeded per run and removed after it.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
const databaseUrl = Bun.env.DATABASE_URL;
const chrome = chromePath();

test("a questions card on a phone: an @mention to wait on, keys to press, the next question at the edge", async () => {
  if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
    throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
  if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
    throw new Error("DATABASE_URL must target local PostgreSQL");
  if (!chrome) throw new Error("Chrome is required (COFORGE_E2E_CHROME)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
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
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: 1 } });
  const labels = (names: string[], prefix: string) =>
    names.map((label, index) => ({ id: `${prefix}${index}`, label }));
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
            id: "region",
            prompt: "Which deploy region should we target?",
            select: "one",
            options: labels(
              ["US East", "US West", "EU Central", "Asia Pacific", "Middle East"],
              "r",
            ),
          },
          {
            id: "checks",
            prompt: "Which pre-release checks should run?",
            select: "many",
            options: labels(["Unit tests", "End-to-end tests"], "c"),
          },
        ],
        to: asked.id,
      },
      preparedByAgentId: agent.id,
    },
  });

  const browser = await launchHeadlessChrome(chrome);
  try {
    const page = await browser.open(`${origin}/en/w/${workspace.slug}/channel/${channel.id}`, {
      phone: { width: 390, height: 844 },
    });
    const card = `document.querySelector('[data-message-id="${asking.id}"] [data-questions-card]')`;
    const shown = (id: string) =>
      `${card}?.querySelector('[data-question="${id}"]:not([inert])') != null`;
    await until(() => page.evaluate<boolean>(`${shown("region")}`), 60_000);
    await page.evaluate(`${card}.scrollIntoView({ block: "center" })`);
    expect(await page.evaluate<boolean>(`matchMedia("(pointer: coarse)").matches`)).toBe(true);

    // Whom it waits on reads as a message's @mention would (task #563): the chip, no face.
    const waiting = await page.evaluate<{ chip: string | null; faces: number }>(`(() => {
      const p = [...${card}.querySelectorAll("p")].find((el) => el.textContent.startsWith("Waiting for"));
      return { chip: p.querySelector(".message-markdown-mention")?.textContent ?? null,
        faces: p.querySelectorAll("[data-avatar]").length };
    })()`);
    expect(waiting).toEqual({ chip: "@Raft QA", faces: 0 });

    // Each arrow takes a press anywhere in a 44px square around its middle.
    const arrows = await page.evaluate<{ label: string; corners: boolean[] }[]>(`(() =>
      [...${card}.querySelectorAll('button[aria-label="Back"], button[aria-label="Next"]')].map((button) => {
        const box = button.getBoundingClientRect();
        const x = (box.left + box.right) / 2, y = (box.top + box.bottom) / 2;
        return { label: button.getAttribute("aria-label"), corners: [[-21, -21], [21, -21], [-21, 21], [21, 21]]
          .map(([dx, dy]) => button.contains(document.elementFromPoint(x + dx, y + dy))) };
      }))()`);
    expect(arrows.map((arrow) => arrow.label)).toEqual(["Back", "Next"]);
    for (const arrow of arrows) expect(arrow.corners).toEqual([true, true, true, true]);

    // The next question shows at the right edge, inside the card.
    const peek = await page.evaluate<{ visible: boolean; shows: number }>(`(() => {
      const next = ${card}.querySelector('[data-question-peek]');
      const grid = next.parentElement.getBoundingClientRect();
      return { visible: getComputedStyle(next).visibility === "visible",
        shows: grid.right - next.getBoundingClientRect().left };
    })()`);
    expect(peek.visible).toBe(true);
    expect(peek.shows).toBeGreaterThan(8);

    // A swipe to the left turns to it, and the card keeps its height.
    const height = () => page.evaluate<number>(`${card}.getBoundingClientRect().height`);
    const before = await height();
    const at = await page.evaluate<{ x: number; y: number }>(`(() => {
      const box = ${card}.querySelector('[data-question="region"]').getBoundingClientRect();
      return { x: box.left + box.width * 0.75, y: box.top + 40 };
    })()`);
    const touch = (type: string, x: number) =>
      page.command("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y: at.y }],
      });
    await touch("touchStart", at.x);
    for (const step of [10, 30, 60, 90, 120]) await touch("touchMove", at.x - step);
    await touch("touchEnd", at.x - 120);
    await until(() => page.evaluate<boolean>(shown("checks")));
    expect(await height()).toBe(before);
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
