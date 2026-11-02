import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A menu's submenu stays on screen on a phone (task #442): at 390px neither side of the board's
 * Filter menu has room for its Owner submenu, which used to open past the right edge and widen
 * the page. It now opens below its item, inside the viewport; on a desktop it still opens beside
 * the menu.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel and its Task
 * are seeded per run and removed after it. Screenshots are written under `.amp/e2e/submenu-phone/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/submenu-phone");

test("a submenu opens inside the viewport on a phone and beside its menu on a desktop", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `submenu-phone-${process.pid}`);
  const suffix = `${process.pid}-${Date.now()}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-submenu-${suffix}`,
      description: "",
      members: { create: { userId: DEV_BROWSER_USER.id } },
    },
  });
  const title = `Submenu work ${suffix}`;
  await new TaskBoard(db).execute({ workspaceId, userId: DEV_BROWSER_USER.id }, {
    idempotencyKey: crypto.randomUUID(),
    conversationId: channel.id,
    operation: "create",
    title,
  } as Parameters<TaskBoard["execute"]>[1]);
  const box = (selector: string) =>
    evaluate<{ left: number; right: number }>(
      `(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { left: b.left, right: b.right }; })()`,
    );
  /** The popover holding `selector` has finished its entry motion. */
  const settled = (selector: string) =>
    `document.querySelector('${selector}')?.closest("[data-trigger]")?.getAnimations().length === 0`;
  const filterMenu = `[role="menu"][aria-label="Filter"]`;
  const ownerMenu = `[role="menu"][aria-label="Owner"]`;
  async function openOwner(width: number, height: number) {
    await browser("set", "viewport", String(width), String(height));
    await browser(
      "open",
      `${origin}/en/w/${workspace.slug}/channel/${channel.id}?view=tasks&layout=board`,
    );
    await browser(
      "wait",
      "--fn",
      `document.body.textContent.includes(${JSON.stringify(title)}) && ${pageHydrated}`,
    );
    await browser("find", "role", "button", "click", "--name", "Filter");
    await browser("wait", "--fn", `document.querySelector('${filterMenu}') !== null`);
    await browser("find", "role", "menuitem", "click", "--name", "Owner");
    await browser("wait", "--fn", `document.querySelector('${ownerMenu}') !== null`);
    // Past the popover's entry motion, so its box and the screenshot are where it rests.
    await browser("wait", "--fn", settled(ownerMenu));
  }
  try {
    await mkdir(artifacts, { recursive: true });

    // A phone: the submenu stays inside the viewport and the page does not widen.
    await openOwner(390, 844);
    const owner = await box(ownerMenu);
    expect(owner.left).toBeGreaterThanOrEqual(0);
    expect(owner.right).toBeLessThanOrEqual(390);
    expect(await evaluate<number>("document.documentElement.scrollWidth")).toBeLessThanOrEqual(390);
    await browser("screenshot", join(artifacts, "phone.png"));

    // A pointer: hovering the item opens the submenu below it, and moving down into it keeps it
    // open, crossing no other item of the menu on the way.
    await browser("press", "Escape");
    await browser("press", "Escape");
    await browser("find", "role", "button", "click", "--name", "Filter");
    await browser("wait", "--fn", `document.querySelector('${filterMenu}') !== null`);
    await browser("find", "role", "menuitem", "hover", "--name", "Owner");
    await browser("wait", "--fn", `document.querySelector('${ownerMenu}') !== null`);
    await browser("wait", "--fn", settled(ownerMenu));
    const item = `${ownerMenu} [role="menuitemcheckbox"], ${ownerMenu} [role="menuitem"]`;
    const target = await evaluate<[number, number]>(
      `(() => { const b = document.querySelector(${JSON.stringify(item)}).getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]; })()`,
    );
    const owner0 = await evaluate<[number, number]>(
      `(() => { const b = [...document.querySelectorAll('${filterMenu} [role="menuitem"]')].find((el) => el.textContent.includes("Owner")).getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]; })()`,
    );
    for (let step = 1; step <= 6; step += 1)
      await browser(
        "mouse",
        "move",
        String(Math.round(owner0[0] + ((target[0] - owner0[0]) * step) / 6)),
        String(Math.round(owner0[1] + ((target[1] - owner0[1]) * step) / 6)),
      );
    await Bun.sleep(300);
    expect(await evaluate<boolean>(`document.querySelector('${ownerMenu}') !== null`)).toBe(true);

    // A desktop: beside the menu, as before.
    await openOwner(1440, 900);
    const [menu, beside] = [await box(filterMenu), await box(ownerMenu)];
    expect(beside.left).toBeGreaterThanOrEqual(menu.right - 8);
    await browser("screenshot", join(artifacts, "desktop.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
