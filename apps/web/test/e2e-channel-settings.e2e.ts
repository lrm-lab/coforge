import { afterAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  animationsSettled,
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
  seededUuid,
} from "./helpers/browser-e2e";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/channel-settings");
const notifyArtifacts = join(import.meta.dir, "../../../.artifacts/e2e/channel-notify-menu");

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const session = `channel-settings-${process.pid}`;
const { browser, evaluate, waitFor, byText, clickText } = browserSession(browserPath, session);

const channelHeader = `document.querySelector("header h1[data-channel-title]")?.closest("header")`;
const panelSelector = 'section[aria-label="Channel details and settings"]';
const panelOpen = `document.querySelector('${panelSelector}') !== null`;
const settledAnimations = animationsSettled({ allowInfinite: true });

async function openPanel() {
  await waitFor(
    `document.querySelector('[aria-label="Channel details and settings"]') !== null`,
    15_000,
  );
  for (let attempt = 0; ; attempt += 1) {
    await browser("click", '[aria-label="Channel details and settings"]');
    const opened = await waitFor(panelOpen, 5_000).then(
      () => true,
      () => false,
    );
    if (opened) return;
    if (attempt === 5) throw new Error("the channel settings panel never opened");
  }
}

afterAll(async () => {
  await browser("close").catch(() => undefined);
  await db.$disconnect();
});

test("the channel settings panel edits info, preferences, archive and membership", async () => {
  const channelId = seededUuid("e2e-channel-settings:channel");
  const channelName = "e2e-settings";
  const renamed = "e2e-settings-renamed";
  try {
    const { workspaceId, workspace } = await devBrowserWorkspace(db);
    const workspacePath = `/en/w/${workspace.slug}`;
    await db.conversation.deleteMany({
      where: { workspaceId, channelName: renamed, NOT: { id: channelId } },
    });
    await db.conversation.upsert({
      where: { id: channelId },
      update: { channelName, description: "", archivedAt: null },
      create: { id: channelId, workspaceId, channelName, description: "" },
    });
    await db.conversationMember.upsert({
      where: { conversationId_userId: { conversationId: channelId, userId: DEV_BROWSER_USER.id } },
      update: {
        leftAt: null,
        channelRole: "admin",
        notificationLevel: "all",
        channelMuted: false,
        hiddenAt: new Date(),
      },
      create: {
        conversationId: channelId,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
        channelRole: "admin",
        hiddenAt: new Date(),
      },
    });
    await db.conversationPin.deleteMany({ where: { conversationId: channelId } });
    const viewerRow = () =>
      db.conversationMember.findUniqueOrThrow({
        where: {
          conversationId_userId: { conversationId: channelId, userId: DEV_BROWSER_USER.id },
        },
        include: { pins: true },
      });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}${workspacePath}/channel/${channelId}`);
    await waitFor(
      `document.querySelector('[aria-label="Channel details and settings"]') !== null`,
      60_000,
    );

    const headerButtons = await evaluate<string[]>(
      `[...${channelHeader}.querySelectorAll("button")].map((button) => button.getAttribute("aria-label") ?? button.textContent.trim())`,
    );
    expect(headerButtons).toContain("Channel details and settings");
    expect(headerButtons).not.toContain("Members");

    await openPanel();
    await waitFor(
      `[...document.querySelectorAll('${panelSelector} h3')].some((heading) => heading.textContent.startsWith("Members"))`,
    );
    const identity = await evaluate<{ title: string; text: string }>(`(() => {
      const panel = document.querySelector('${panelSelector}');
      return { title: panel.querySelector("[data-details-channel-name]").textContent, text: panel.textContent };
    })()`);
    expect(identity.title).toBe(channelName);
    for (const label of [
      "Details",
      "Public",
      "Members",
      "Channel settings",
      "Your preferences",
      "Archive channel",
      "Leave channel",
    ])
      expect(identity.text).toContain(label);
    await waitFor(`document.querySelector('${panelSelector}').textContent.includes("1 human")`);
    await browser("screenshot", join(artifacts, "panel.png"));

    await clickText(`${panelSelector} button`, "Edit");
    await waitFor(`document.querySelector('${panelSelector} textarea') !== null`);
    await browser("fill", `${panelSelector} textarea`, "Where settings get tested");
    await clickText(`${panelSelector} button`, "Save");
    await waitFor(`document.querySelector('${panelSelector} textarea') === null`);
    await waitFor(
      `document.querySelector('${panelSelector}').textContent.includes("Where settings get tested")`,
    );
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: channelId } })).description,
    ).toBe("Where settings get tested");

    await clickText(`${panelSelector} button`, "Edit");
    await waitFor(`document.querySelector('${panelSelector} input[type="text"]') !== null`);
    await browser("fill", `${panelSelector} input[type="text"]`, renamed);
    await clickText(`${panelSelector} button`, "Save");
    await waitFor(
      `${channelHeader}?.querySelector("h1 [data-channel-name]").textContent === "${renamed}"`,
    );
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: channelId } })).channelName,
    ).toBe(renamed);

    await clickText(`${panelSelector} button`, "Edit");
    await waitFor(`document.querySelector('${panelSelector} textarea') !== null`);
    await browser("fill", `${panelSelector} textarea`, "Never saved");
    await browser("press", "Escape");
    await waitFor(`${byText("h2", "Unsaved changes")} !== undefined`);
    await browser("screenshot", join(artifacts, "unsaved-prompt.png"));
    await clickText("button", "Discard changes");
    await waitFor(`!(${panelOpen})`);
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: channelId } })).description,
    ).toBe("Where settings get tested");

    await openPanel();
    const sidebarSection = `document.querySelector('${panelSelector} button[aria-label^="Sidebar section"], ${panelSelector} [aria-label="Sidebar section"] button')`;
    await browser("eval", `${sidebarSection}.click()`);
    await waitFor(`${byText('[role="option"]', "Pinned")} !== undefined`);
    await clickText('[role="option"]', "Pinned");
    await waitFor(`${sidebarSection}.textContent.includes("Pinned")`);
    const notify = `document.querySelector('${panelSelector} button[aria-label^="Notifications"], ${panelSelector} [aria-label="Notifications"] button')`;
    await browser("eval", `${notify}.click()`);
    await waitFor(`${byText('[role="option"]', "Mute")} !== undefined`);
    await clickText('[role="option"]', "Mute");
    await waitFor(`${notify}.textContent.includes("Mute")`);
    for (
      let i = 0;
      i < 50 && (!(await viewerRow()).channelMuted || (await viewerRow()).pins.length === 0);
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    const preferred = await viewerRow();
    expect(preferred.pins.length).toBe(1);
    expect(preferred.channelMuted).toBe(true);

    await clickText("button", "Archive channel");
    await waitFor(`document.body.textContent.includes("This channel is archived.")`);
    await waitFor(
      `[...document.querySelectorAll("[data-toast]")].some((t) => t.textContent.includes("Archived #"))`,
    );
    expect(await evaluate<boolean>(`document.querySelector("main textarea") === null`)).toBe(true);
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: channelId } })).archivedAt,
    ).not.toBeNull();
    await browser("screenshot", join(artifacts, "archived.png"));

    await clickText("button", "Unarchive");
    await waitFor(panelOpen);
    const archivedPanel = await evaluate<{ leave: boolean; editHidden: boolean }>(`(() => {
      const panel = document.querySelector('${panelSelector}');
      return {
        leave: panel.textContent.includes("Leave channel"),
        editHidden: [...panel.querySelectorAll("button")].every((b) => b.textContent.trim() !== "Edit"),
      };
    })()`);
    expect(archivedPanel).toEqual({ leave: false, editHidden: true });
    await clickText("button", "Unarchive channel");
    await waitFor(`!document.body.textContent.includes("This channel is archived.")`);
    await browser("press", "Escape");
    await waitFor(`!(${panelOpen})`);
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: channelId } })).archivedAt,
    ).toBeNull();

    await openPanel();
    await clickText("button", "Leave channel");
    await waitFor(`${byText("button", "Join channel")} !== undefined`);
    expect((await viewerRow()).leftAt).not.toBeNull();
    const leftToast = `[...document.querySelectorAll("[data-toast]")].find((t) => t.textContent.includes("Left #"))`;
    await waitFor(`${leftToast} !== undefined`);
    await evaluate(
      `([...${leftToast}.querySelectorAll("button")].find((b) => b.textContent.trim() === "Undo").setAttribute("data-e2e-undo", ""), true)`,
    );
    await browser("wait", "--fn", settledAnimations);
    await browser("click", "[data-e2e-undo]");
    await waitFor(`document.querySelector("main textarea") !== null`);
    expect((await viewerRow()).leftAt).toBeNull();

    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}${workspacePath}/channel/${channelId}`);
    await waitFor(
      `document.querySelector('[aria-label="Channel details and settings"]') !== null`,
      60_000,
    );
    await openPanel();
    const phone = await evaluate<{ panelWidth: number; viewport: number }>(`(() => {
      const panel = document.querySelector('${panelSelector}');
      return { panelWidth: panel.getBoundingClientRect().width, viewport: innerWidth };
    })()`);
    expect(phone.panelWidth).toBeLessThanOrEqual(phone.viewport);
    await browser("screenshot", join(artifacts, "phone.png"));
  } finally {
    await db.conversationPin.deleteMany({ where: { conversationId: channelId } });
    await db.conversation.deleteMany({ where: { id: channelId } });
  }
}, 120_000);

test("a channel's notification level is chosen from its row menu and its settings", async () => {
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
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
  const settled = () => browser("wait", "--fn", settledAnimations);
  const shoot = async (shot: string) => {
    await settled();
    await browser("screenshot", join(notifyArtifacts, `${shot}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    try {
      await browser("screenshot", join(notifyArtifacts, `${shot}-dark.png`));
    } finally {
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`).catch(
        () => undefined,
      );
    }
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
  const item = (text: string) =>
    `[...[...document.querySelectorAll('[role="menu"]')].at(-1).querySelectorAll('[role^="menuitem"]')].find((el) => el.textContent.trim().startsWith(${JSON.stringify(text)}))`;
  const menus = `document.querySelectorAll('[role="menu"]').length`;
  const openNotificationsSubmenu = async () => {
    await browser("wait", "--fn", `${item("Notifications")} != null`);
    await evaluate(`(${item("Notifications")}.focus(), true)`);
    await browser("press", "ArrowRight");
    await browser("wait", "--fn", `${menus} === 2`);
  };
  try {
    await mkdir(notifyArtifacts, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    await browser("open", `${origin}/en/w/${workspace.slug}`);
    await browser("wait", "--fn", `${pageHydrated} && ${row} != null`);

    await evaluate(rightClick);
    await openNotificationsSubmenu();
    expect(
      await evaluate<string | null>(`${item("All new messages")}.getAttribute("aria-checked")`),
    ).toBe("true");
    await shoot("desktop-1-menu");
    await evaluate(`(${item("Nothing")}.click(), true)`);
    await browser("wait", "--fn", `${menus} === 0`);
    for (let i = 0; i < 50 && (await level()).notificationLevel !== "none"; i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await level()).toEqual({ notificationLevel: "none", channelMuted: false });

    await evaluate(rightClick);
    await openNotificationsSubmenu();
    expect(await evaluate<string | null>(`${item("Nothing")}.getAttribute("aria-checked")`)).toBe(
      "true",
    );
    await evaluate(`(${item("Nothing")}.click(), true)`);
    await browser("wait", "--fn", `${menus} === 0`);

    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}`);
    await browser("wait", "--fn", pageHydrated);
    await openPanel();
    const select = `document.querySelector('${panelSelector} button[aria-label^="Notifications"], ${panelSelector} [aria-label="Notifications"] button')`;
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

    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/w/${workspace.slug}`);
    await browser("wait", "--fn", `${pageHydrated} && ${row} != null`);
    await evaluate(rightClick);
    await openNotificationsSubmenu();
    expect(await evaluate<string | null>(`${item("Mute")}.getAttribute("aria-checked")`)).toBe(
      "true",
    );
    await shoot("phone-menu");
  } finally {
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`).catch(
      () => undefined,
    );
    await db.conversation.deleteMany({ where: { id: channel.id } });
  }
}, 180_000);
