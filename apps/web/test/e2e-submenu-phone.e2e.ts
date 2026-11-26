import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/submenu-phone");

test("a submenu opens inside the viewport on a phone and beside its menu on a desktop", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `submenu-phone-${process.pid}`);
  const suffix = `${process.pid}-${Date.now()}`;
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
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
  const settled = (selector: string) =>
    `document.querySelector('${selector}')?.closest("[data-trigger]")?.getAnimations().every((animation) => animation.playState !== "running") === true`;
  const filterMenu = `[role="menu"][aria-label="Filter"]`;
  const ownerMenu = `[role="menu"][aria-label="Owner"]`;
  const ownerRow = `[...document.querySelectorAll('${filterMenu} [role="menuitem"]')].find((el) => el.textContent.includes("Owner"))`;
  const movePointerIntoOwnerMenu = async () => {
    const item = `${ownerMenu} [role="menuitemcheckbox"], ${ownerMenu} [role="menuitem"]`;
    const target = await evaluate<[number, number]>(
      `(() => { const b = document.querySelector(${JSON.stringify(item)}).getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]; })()`,
    );
    const owner0 = await evaluate<[number, number]>(
      `(() => { const b = ${ownerRow}.getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]; })()`,
    );
    for (let step = 1; step <= 6; step += 1)
      await browser(
        "mouse",
        "move",
        String(Math.round(owner0[0] + ((target[0] - owner0[0]) * step) / 6)),
        String(Math.round(owner0[1] + ((target[1] - owner0[1]) * step) / 6)),
      );
    await Bun.sleep(350);
    expect(await evaluate<boolean>(`document.querySelector('${ownerMenu}') !== null`)).toBe(true);
  };
  const assertHoverDoesNotOpenOwner = async () => {
    await browser("find", "role", "menuitem", "hover", "--name", "Owner");
    await Bun.sleep(400);
    expect(await evaluate<boolean>(`document.querySelector('${ownerMenu}') === null`)).toBe(true);
    expect(await evaluate<string | null>(`${ownerRow}?.getAttribute("aria-expanded")`)).toBe(
      "false",
    );
  };
  async function openOwner(width: number, height: number, verifyHoverClosed = false) {
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
    await browser("wait", "--fn", settled(filterMenu));
    if (verifyHoverClosed) await assertHoverDoesNotOpenOwner();
    await browser("find", "role", "menuitem", "click", "--name", "Owner");
    await browser("wait", "--fn", `document.querySelector('${ownerMenu}') !== null`);
    await browser("wait", "--fn", settled(ownerMenu));
  }
  try {
    await mkdir(artifacts, { recursive: true });

    await openOwner(390, 844);
    const owner = await box(ownerMenu);
    expect(owner.left).toBeGreaterThanOrEqual(0);
    expect(owner.right).toBeLessThanOrEqual(390);
    expect(await evaluate<number>("document.documentElement.scrollWidth")).toBeLessThanOrEqual(390);
    await browser("screenshot", join(artifacts, "phone.png"));

    await browser("press", "Escape");
    await browser("press", "Escape");
    await browser("find", "role", "button", "click", "--name", "Filter");
    await browser("wait", "--fn", `document.querySelector('${filterMenu}') !== null`);
    await browser("wait", "--fn", settled(filterMenu));
    await assertHoverDoesNotOpenOwner();
    await browser("find", "role", "menuitem", "click", "--name", "Owner");
    await browser("wait", "--fn", `document.querySelector('${ownerMenu}') !== null`);
    await browser("wait", "--fn", settled(ownerMenu));
    await movePointerIntoOwnerMenu();

    await openOwner(1440, 900, true);
    const [menu, beside] = [await box(filterMenu), await box(ownerMenu)];
    expect(beside.left).toBeGreaterThanOrEqual(menu.right - 8);
    await browser("screenshot", join(artifacts, "desktop.png"));
    await movePointerIntoOwnerMenu();
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
