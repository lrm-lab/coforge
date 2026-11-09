import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { seedActivityKeys } from "./helpers/activity-keys-seed";

/**
 * The Activity header's Mark all done and Mark all read in a real browser: Mark all done empties
 * the All list and its toast's Undo brings the rows back; a hovered row shows only its Done check;
 * the header offers both buttons on All and only Mark all read on Unread and Mentions.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
/** The list's rows, under whichever day heading they sit (the list is named by its day). */
const rowItems = JSON.stringify("[data-activity-list] ol > li");

test("Activity's header marks all done with Undo, and a row's hover shows only Done", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(
    browserPath,
    `activity-bulk-${process.pid}`,
  );
  const rows = `[...document.querySelectorAll(${rowItems})]`;
  const seeded = `${rows}.filter((row) => row.textContent.includes("e2e-keys"))`;
  /** The labels of the header's visible buttons (a narrow column shows icons, not labels). */
  const headerButtons = `[...document.querySelectorAll("[data-activity-list] > div > header button")].filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim())`;
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

    // On All the header offers both; on Unread and Mentions only Mark all read.
    expect(await evaluate<string[]>(headerButtons)).toEqual(["Mark all read", "Mark all done"]);
    for (const tab of ["Unread", "Mentions"]) {
      await browser("find", "role", "tab", "click", "--name", tab);
      await waitFor(`${headerButtons}.length === 1`);
      expect(await evaluate<string[]>(headerButtons)).toEqual(["Mark all read"]);
    }
    await browser("find", "role", "tab", "click", "--name", "All");
    await waitFor(`${headerButtons}.length === 2`);

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
    await evaluate(
      `([...document.querySelectorAll("[data-activity-list] > div > header button")].find((b) => b.textContent.trim() === "Mark all done").click(), true)`,
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
