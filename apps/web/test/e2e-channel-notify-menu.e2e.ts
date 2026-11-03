import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A channel's notification level (task #401): the sidebar row's right-click menu has a
 * "Notifications" submenu with the four levels, the current one ticked; the channel's settings
 * panel offers the same four. Choosing one writes the viewer's own membership; only Mute changes
 * the row (dimmed, the muted icon).
 *
 * Opt-in like the other browser E2Es (real local Web and `agent-browser`). The channel is seeded
 * per run and removed after it. Screenshots go under `.amp/e2e/channel-notify-menu/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/channel-notify-menu");

test("a channel's notification level is chosen from its row menu and its settings", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `channel-notify-${process.pid}`);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const name = `a-notify-${tail}`;
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: name,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id, channelRole: "admin" }] },
    },
  });
  const level = async () =>
    await db.conversationMember.findFirstOrThrow({
      where: { conversationId: channel.id, userId: DEV_BROWSER_USER.id },
      select: { notificationLevel: true, channelMuted: true },
    });
  const settled = () =>
    browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
  const shoot = async (shot: string) => {
    await settled();
    await browser("screenshot", join(artifacts, `${shot}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("screenshot", join(artifacts, `${shot}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  const row = `[...document.querySelectorAll("a")].find((a) => a.textContent.includes(${JSON.stringify(name)}))`;
  const rightClick = `(() => {
    const link = ${row};
    link.scrollIntoView({ block: "center" });
    const box = link.getBoundingClientRect();
    link.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: box.x + 20, clientY: box.y + 10,
    }));
    return true;
  })()`;
  // A row of the newest menu (the submenu once it is open) whose label starts with `text`.
  const item = (text: string) =>
    `[...[...document.querySelectorAll('[role="menu"]')].at(-1).querySelectorAll('[role^="menuitem"]')].find((el) => el.textContent.trim().startsWith(${JSON.stringify(text)}))`;
  const menus = `document.querySelectorAll('[role="menu"]').length`;
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    await browser("open", `${origin}/en/w/${workspace.slug}`);
    await browser("wait", "--fn", `${pageHydrated} && ${row} != null`);

    // The row menu: "Notifications" reads the current level and opens the four, "All" ticked.
    await evaluate(rightClick);
    await browser("wait", "--fn", `${item("Notifications")} != null`);
    await evaluate(`(${item("Notifications")}.click(), true)`);
    await browser("wait", "--fn", `${menus} === 2`);
    expect(
      await evaluate<string | null>(`${item("All new messages")}.getAttribute("aria-checked")`),
    ).toBe("true");
    await shoot("desktop-1-menu");
    await evaluate(`(${item("Nothing")}.click(), true)`);
    await browser("wait", "--fn", `${menus} === 0`);
    for (let i = 0; i < 50 && (await level()).notificationLevel !== "none"; i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await level()).toEqual({ notificationLevel: "none", channelMuted: false });

    // Opened again, the menu ticks the level chosen.
    await evaluate(rightClick);
    await browser("wait", "--fn", `${item("Notifications")} != null`);
    await evaluate(`(${item("Notifications")}.click(), true)`);
    await browser("wait", "--fn", `${menus} === 2`);
    expect(await evaluate<string | null>(`${item("Nothing")}.getAttribute("aria-checked")`)).toBe(
      "true",
    );
    // Choosing the level it has closes the menu and writes nothing.
    await evaluate(`(${item("Nothing")}.click(), true)`);
    await browser("wait", "--fn", `${menus} === 0`);

    // The settings panel: the same four, the current one shown, its line saying what it does.
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}`);
    await browser("wait", "--fn", pageHydrated);
    const panelOpen = `document.querySelector('[role="dialog"][aria-label="Channel Details and Settings"]') !== null`;
    // A click that lands before the page hydrates opens nothing; try again until the panel opens.
    for (let attempt = 0; !(await evaluate<boolean>(panelOpen)); attempt += 1) {
      if (attempt === 5) throw new Error("the channel settings panel never opened");
      await evaluate(
        `(document.querySelector('button[aria-label="Channel Details and Settings"]')?.click(), true)`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const select = `document.querySelector('[role="dialog"] button[aria-label^="Notifications"], [role="dialog"] [aria-label="Notifications"] button')`;
    await browser("wait", "--fn", `${select} != null`);
    await evaluate(`(${select}.scrollIntoView({ block: "center" }), true)`);
    expect(await evaluate<string>(`${select}.textContent`)).toContain("Nothing");
    expect(
      await evaluate<boolean>(
        `document.body.textContent.includes("No notifications; unread still counts")`,
      ),
    ).toBe(true);
    await evaluate(`(${select}.click(), true)`);
    const option = (text: string) =>
      `[...document.querySelectorAll('[role="option"]')].find((el) => el.textContent.includes(${JSON.stringify(text)}))`;
    await browser("wait", "--fn", `${option("Mute")} != null`);
    await shoot("desktop-2-settings");
    await evaluate(`(${option("Mute")}.click(), true)`);
    for (let i = 0; i < 50 && (await level()).notificationLevel !== "muted"; i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await level()).toEqual({ notificationLevel: "muted", channelMuted: true });
    await shoot("desktop-3-muted");

    // The phone: a long press opens the same menu (the contextmenu event the browser sends).
    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/w/${workspace.slug}`);
    await browser("wait", "--fn", `${pageHydrated} && ${row} != null`);
    await evaluate(rightClick);
    await browser("wait", "--fn", `${item("Notifications")} != null`);
    await evaluate(`(${item("Notifications")}.click(), true)`);
    await browser("wait", "--fn", `${menus} === 2`);
    expect(await evaluate<string | null>(`${item("Mute")}.getAttribute("aria-checked")`)).toBe(
      "true",
    );
    await shoot("phone-menu");
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
