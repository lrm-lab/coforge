import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { rowItems } from "./helpers/activity-inbox-e2e";
import { seedActivityKeys } from "./helpers/activity-keys-seed";

/**
 * The Activity header's Mark all done and Mark all read in a real browser: Mark all done empties
 * the All list and its toast's Undo brings the rows back; a hovered row shows only its Done check;
 * the header offers both buttons on All and only Mark all read on Unread and Mentions.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();

test("Activity's header marks all done with Undo, and a row's hover shows only Done", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(
    browserPath,
    `activity-bulk-${process.pid}`,
  );
  const rows = `[...document.querySelectorAll(${rowItems})]`;
  const seeded = `${rows}.filter((row) => row.textContent.includes("e2e-keys"))`;
  /** The header's "More actions" (⋯) button, and the items of the menu it opens. */
  const moreButton = `document.querySelector('[data-activity-list] header button[aria-label="More actions"]')`;
  const menuItems = `[...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent.trim())`;
  // A real click, so focus moves into the menu and Escape reaches it.
  const openMenu = async () => {
    await browser("click", `[data-activity-list] header button[aria-label="More actions"]`);
    await waitFor(`${menuItems}.length > 0`);
  };
  // Gone, not just closing: a menu animating out keeps its items (task #479).
  const closeMenu = async () => {
    await browser("press", "Escape");
    await waitFor(`document.querySelectorAll('[role="menu"]').length === 0`);
  };
  const toastButton = `[...document.querySelectorAll("[data-sonner-toast] button")].find((b) => b.textContent.trim() === "Undo")`;
  const openSeeded = async (workspaceSlug: string) => {
    await browser("open", `${origin}/en/w/${workspaceSlug}/activity`);
    await waitFor(`${seeded}.length === 4 && ${pageHydrated}`, 40_000);
    // Let the first reads and the realtime join settle: a refresh then would redraw the rows.
    await Bun.sleep(1_500);
  };
  try {
    const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    await seedActivityKeys(db, workspaceId);
    await browser("set", "viewport", "1440", "900");
    await openSeeded(workspace.slug);

    // On All the ⋯ menu offers both; on Unread only Mark all read. Both reach every row of the
    // list, so Mentions, which shows only some of them, offers no menu at all.
    await openMenu();
    expect(await evaluate<string[]>(menuItems)).toEqual(["Mark all read", "Mark all done"]);
    await closeMenu();
    await browser("find", "role", "tab", "click", "--name", "Unread");
    await waitFor(`location.search.includes("unread") && ${moreButton} !== null`);
    // The tab's own list replaces the previous one's placeholder rows (and its menu) a beat later.
    await Bun.sleep(1_500);
    await openMenu();
    expect(await evaluate<string[]>(menuItems)).toEqual(["Mark all read"]);
    await closeMenu();
    await browser("find", "role", "tab", "click", "--name", "Mentions");
    await waitFor(`location.search.includes("mentions")`);
    await Bun.sleep(1_000);
    expect(await evaluate<boolean>(`${moreButton} === null`)).toBe(true);
    await browser("find", "role", "tab", "click", "--name", "All");
    await waitFor(`${moreButton} !== null`);

    // A hovered row floats one button, Done, which is hidden at rest.
    const first = `${seeded}[0]`;
    const done = `${first}.querySelectorAll('button[aria-label="Mark as done"]')`;
    const shown = `Number(getComputedStyle(${done}[0]).opacity)`;
    expect(await evaluate<number>(`${done}.length`)).toBe(1);
    expect(await evaluate<number>(`${first}.querySelectorAll("button").length`)).toBe(1);
    expect(await evaluate<number>(shown)).toBe(0);
    await evaluate(`(${first}.setAttribute("data-shot", "row"), true)`);
    await browser("hover", "[data-shot=row] a");
    await waitFor(`${shown} === 1`);

    // Mark all done empties the list; its Undo refills it.
    await openMenu();
    await evaluate(
      `([...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.trim() === "Mark all done").click(), true)`,
    );
    await waitFor(`${seeded}.length === 0`);
    await waitFor(`${toastButton} !== undefined`);
    expect(
      await evaluate<boolean>(
        `document.querySelector("[data-sonner-toast]").textContent.includes("Marked")`,
      ),
    ).toBe(true);
    await evaluate(`(${toastButton}.click(), true)`);
    await waitFor(`${seeded}.length === 4`);
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);
