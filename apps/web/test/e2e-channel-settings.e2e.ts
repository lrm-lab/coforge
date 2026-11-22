import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * The channel settings panel in a real browser. The header's gear opens a slideout naming the
 * channel with its Public badge and member summary. A channel admin saves a new description and
 * name from Info. Closing with unsaved edits asks first. Pin and the notification level change
 * only the viewer's membership. Archiving (after a confirmation) replaces the composer with an archived notice
 * whose Unarchive opens the panel to bring it back. Leaving (after a confirmation) turns the channel read-only
 * until the viewer rejoins.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel is seeded
 * deterministically and reset on every run. Screenshots are written under
 * `.artifacts/e2e/channel-settings/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/channel-settings");

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

test("the channel settings panel edits info, preferences, archive and membership", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `channel-settings-${process.pid}`;
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
  async function evaluate<T>(expression: string): Promise<T> {
    return JSON.parse(JSON.parse(await browser("eval", `JSON.stringify(${expression})`))) as T;
  }
  /** Waits for `condition`, failing with its text rather than at the test timeout; a first page
   * load compiles on the dev server, so it gets longer. */
  const waitFor = (condition: string, ms = 20_000) =>
    Promise.race([
      browser("wait", "--fn", condition),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for ${condition}`)), ms),
      ),
    ]);
  const channelHeader = `document.querySelector("header h1[data-channel-title]")?.closest("header")`;
  const panelSelector = 'section[aria-label="Channel details and settings"]';
  const panelOpen = `document.querySelector('${panelSelector}') !== null`;
  const byText = (selector: string, text: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find((element) => element.textContent.trim() === ${JSON.stringify(text)})`;
  const clickText = (selector: string, text: string) =>
    browser("eval", `${byText(selector, text)}.click()`);
  async function openPanel() {
    // A click that lands before the page hydrates opens nothing; try again until the panel opens.
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

  const channelId = seededUuid("e2e-channel-settings:channel");
  const channelName = "e2e-settings";
  const renamed = "e2e-settings-renamed";
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      orderBy: { createdAt: "asc" },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${membership.workspace.slug}`;
    const workspaceId = membership.workspaceId;
    // Reset: the viewer created the channel (so is its admin), it is live, unpinned and unmuted,
    // and closed in their sidebar, so it is opened by URL and pinned from the panel alone.
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

    // The header shows only the gear; the old Members and Bell buttons are gone.
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

    // Archive: it runs at once (Undo is in its toast, task #7), the panel closes and an archived
    // notice replaces the composer.
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
    // The notice's Unarchive opens the panel, where an archived channel offers no Leave and a
    // frozen Info form.
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

    // Leave a public channel: it runs at once, the channel turns read-only with a Join button, and
    // the toast's Undo joins again (task #7).
    await openPanel();
    await clickText("button", "Leave channel");
    await waitFor(`${byText("button", "Join channel")} !== undefined`);
    expect((await viewerRow()).leftAt).not.toBeNull();
    const leftToast = `[...document.querySelectorAll("[data-toast]")].find((t) => t.textContent.includes("Left #"))`;
    await waitFor(`${leftToast} !== undefined`);
    await evaluate(
      `([...${leftToast}.querySelectorAll("button")].find((b) => b.textContent.trim() === "Undo").setAttribute("data-e2e-undo", ""), true)`,
    );
    await browser(
      "wait",
      "--fn",
      `document.getAnimations().every((a) => a.playState !== "running")`,
    );
    await browser("click", "[data-e2e-undo]");
    // The composer returns once the page has read the viewer as a member again.
    await waitFor(`document.querySelector("main textarea") !== null`);
    expect((await viewerRow()).leftAt).toBeNull();

    // Phone: the panel covers the screen and still scrolls to its actions.
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
    await browser("close").catch(() => undefined);
    await db.conversationPin.deleteMany({ where: { conversationId: channelId } }).catch(() => {});
    await db.$disconnect();
  }
}, 120_000);
