import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";

/**
 * A hover peek that another peek replaced never comes back stuck at the top left of the page
 * (task #154). PreviewTrigger closes the replaced peek instantly; React Aria's Popover then renders
 * nothing while its exit state still turns to exiting, and with no element to watch that exit never
 * ends. The next brush over the first trigger, too short to open it, mounted the Popover again as
 * exiting and unplaced: `position: fixed` at (0, 0), for good.
 *
 * The steps, each one needed (without the swap to B, or with a brush long enough to open A, nothing
 * goes wrong):
 * 1. Hover Agent avatar A until its peek opens.
 * 2. Move up to avatar B, which sits above A so A's peek (below A) does not cover it, by way of a
 *    point between them: leaving A's safe area starts A's close, and B, opening at once while React
 *    Aria is warmed up, closes A instantly. (A single jump onto B leaves A open beside B.)
 * 3. Rest on empty space, away from any tooltip trigger, until the warm-up cools down. (Resting on
 *    the composer's send button would keep it warm through that button's own tooltip.)
 * 4. Brush A for less than the 250ms open delay.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user a member of
 * its Workspace (seed-dev). Each run seeds its own Agent and direct message. Screenshots are
 * written under `.amp/e2e/hover-popover-stuck/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/hover-popover-stuck");

/** HoverPopover's open delay: a brush shorter than this must not open the peek. */
const OPEN_DELAY_MS = 250;
/** React Aria's tooltip cool-down is 500ms; rest a good while longer. */
const COOL_DOWN_MS = 1500;
const ROUNDS = 3;

test("a peek replaced by another one never comes back stuck at the top left", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `hover-popover-stuck-${process.pid}`;
  async function browser(...args: string[]) {
    const child = Bun.spawn([browserPath!, "--session", session, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Browser ${args[0]} failed: ${stderr}`);
    return stdout;
  }
  const eval_ = async (expression: string) => JSON.parse(await browser("eval", expression));
  const point = (at: { x: number; y: number }) => `${Math.round(at.x)} ${Math.round(at.y)}`;
  const move = (at: { x: number; y: number }) => browser("mouse", "move", ...point(at).split(" "));
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const peeks = `[...document.querySelectorAll("[data-trigger='PreviewTrigger']")].map((peek) => ({ position: peek.style.position, y: Math.round(peek.getBoundingClientRect().y), exiting: peek.hasAttribute("data-exiting") }))`;

  const suffix = `${process.pid}-${Date.now()}`;
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const workspaceId = membership.workspaceId;
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-peek-${suffix}`,
      displayName: `Peek ${suffix}`,
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
  const { conversationId } = await new DirectConversations(db).open(
    workspaceId,
    DEV_BROWSER_USER.id,
    { agentId: agent.id },
  );
  try {
    const members = await db.conversationMember.findMany({ where: { conversationId } });
    const agentMember = members.find((member) => member.agentId === agent.id)!;
    const viewerMember = members.find((member) => member.userId === DEV_BROWSER_USER.id)!;
    // Two Agent messages with the viewer's replies between them, so the two avatars sit far enough
    // apart that the lower one's peek does not reach the upper one.
    const senders = [
      agentMember,
      viewerMember,
      viewerMember,
      viewerMember,
      viewerMember,
      agentMember,
    ];
    for (const [index, sender] of senders.entries())
      await db.message.create({
        data: {
          conversationId,
          workspaceId,
          senderMemberId: sender.id,
          body: `Peek message ${index + 1}`,
          sequence: index + 1,
        },
      });

    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${membership.workspace.slug}/dm/${conversationId}`);
    await browser("wait", "--fn", `document.body.textContent.includes("Peek message 6")`);
    const label = JSON.stringify(`Open ${agent.displayName}'s profile`);
    const [upper, lower] = (await eval_(
      `[...document.querySelectorAll('[id^="message-"] button[aria-label]')].filter((button) => button.getAttribute("aria-label") === ${label}).map((button) => { const r = button.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })`,
    )) as { x: number; y: number }[];
    expect(upper && lower).toBeTruthy();
    // Above the composer and right of the messages: nothing there carries a tooltip.
    const empty = { x: 1380, y: (upper!.y + lower!.y) / 2 };

    // React Aria takes a hover for a pointer's only once the pointer has pressed something.
    await move(empty);
    await browser("mouse", "down");
    await browser("mouse", "up");

    // Both with the fade and without it: under prefers-reduced-motion the exit has no animation
    // to wait for, and must end at once just the same.
    for (const motion of ["animated", "reduced"] as const) {
      if (motion === "reduced") {
        await browser("set", "media", "light", "reduced-motion");
        expect(await eval_(`matchMedia("(prefers-reduced-motion: reduce)").matches`)).toBe(true);
      }
      let round = 0;
      for (let attempt = 1; round < ROUNDS; attempt++) {
        if (attempt > ROUNDS * 3)
          throw new Error(
            `${motion}: only ${round} of ${ROUNDS} brushes stayed under the open delay`,
          );
        await move(empty);
        await sleep(COOL_DOWN_MS);
        // 1. A (the lower avatar) opens its peek.
        await move(lower!);
        await browser("wait", "--fn", `${peeks}.some((peek) => !peek.exiting)`);
        // 2. Up towards B: leaving A's safe area starts A's close, and B, opening at once while
        // React Aria is warmed up, then closes A instantly.
        await move({ x: lower!.x, y: (upper!.y + lower!.y) / 2 });
        await move(upper!);
        await sleep(400);
        // 3. Rest on empty space until React Aria cools down.
        await move(empty);
        await sleep(COOL_DOWN_MS);
        expect(await eval_(peeks)).toEqual([]);
        // 4. Brush A, shorter than the open delay: both moves in one browser call. A brush that took
        // longer opened A, which settles the stale exit on its own, so the round proves nothing and
        // runs again.
        const brushStarted = performance.now();
        await browser("batch", `mouse move ${point(lower!)}`, `mouse move ${point(empty)}`);
        if (performance.now() - brushStarted >= OPEN_DELAY_MS) continue;
        round++;
        await sleep(1000);
        const left = (await eval_(peeks)) as { position: string; y: number; exiting: boolean }[];
        if (left.length)
          await browser("screenshot", join(artifacts, `stuck-${motion}-round-${round}.png`));
        expect({ motion, round, left }).toEqual({ motion, round, left: [] });
      }
    }
    await browser("screenshot", join(artifacts, "after.png"));
  } finally {
    await browser("close").catch(() => {});
    await db.message.deleteMany({ where: { conversationId } });
    await db.conversation.delete({ where: { id: conversationId } }).catch(() => {});
    await db.agent.delete({ where: { id: agent.id } }).catch(() => {});
    await db.$disconnect();
  }
}, 120_000);
