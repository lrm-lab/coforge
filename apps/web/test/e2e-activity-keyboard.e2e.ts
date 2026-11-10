import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { openParam } from "./helpers/activity-inbox-e2e";
import { seedActivityKeys } from "./helpers/activity-keys-seed";

/**
 * The Activity list's keyboard in a real browser: Down and Up (and j and k) move the selection,
 * R reads and unreads the selected row, E marks it Done and selects the next row, keys typed in an
 * input do nothing, and Enter opens the selected row.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
/** The list's rows, under whichever day heading they sit (the list is named by its day). */
const rowItems = JSON.stringify("[data-activity-list] ol > li");

test("the Activity list moves, reads, marks Done and opens from the keyboard", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(
    browserPath,
    `activity-keys-${process.pid}`,
  );
  /** Every row's text, in page order; the seeded ones carry `e2e-keys`. */
  const rows = `[...document.querySelectorAll(${rowItems})]`;
  const seeded = `${rows}.filter((row) => row.textContent.includes("e2e-keys"))`;
  /** The index of the row holding focus among all rows, or -1. */
  const focused = `${rows}.findIndex((row) => row.contains(document.activeElement))`;
  const focusSeeded = (index: number) =>
    evaluate(`(${seeded}[${index}].querySelector("a").focus(), true)`);
  /** Whether the seeded row `index` says it has new messages: its count is named "N new" (the
   * number alone is what shows, since the row's redesign on 11-09). */
  const unreadExpression = (index: number) =>
    `[...${seeded}[${index}].querySelectorAll("[aria-label]")].some((el) => /\\d+ new/.test(el.getAttribute("aria-label")))`;
  const isUnread = (index: number) => evaluate<boolean>(unreadExpression(index));
  try {
    const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const { unread, read } = await seedActivityKeys(db, workspaceId);
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/activity`);
    await waitFor(`${seeded}.length === 4 && ${pageHydrated}`, 40_000);
    // Only the selected row is a tab stop.
    expect(
      await evaluate<number>(
        `${rows}.filter((row) => row.hasAttribute("data-activity-row") && row.querySelector("a").tabIndex === 0).length`,
      ),
    ).toBe(1);

    // Arrows and j and k move the selection one row at a time, and stop at the ends.
    // Let the first reads and the realtime join settle: a refresh then would not move focus.
    await Bun.sleep(2_000);
    await focusSeeded(0);
    const start = await evaluate<number>(focused);
    expect(start).toBeGreaterThanOrEqual(0);
    await browser("press", "ArrowDown");
    expect(await evaluate<number>(focused)).toBe(start + 1);
    await browser("press", "j");
    expect(await evaluate<number>(focused)).toBe(start + 2);
    await browser("press", "ArrowUp");
    expect(await evaluate<number>(focused)).toBe(start + 1);
    await browser("press", "k");
    expect(await evaluate<number>(focused)).toBe(start);
    expect(
      await evaluate<number>(
        `${rows}.filter((row) => row.hasAttribute("data-activity-row") && row.querySelector("a").tabIndex === 0).length`,
      ),
    ).toBe(1);

    // R reads the selected unread row, and unreads it again.
    const unreadAt = await evaluate<number>(
      `${seeded}.findIndex((row) => row.textContent.includes("e2e-keys-design") && !row.textContent.includes("launch"))`,
    );
    expect(unreadAt).toBeGreaterThanOrEqual(0);
    await focusSeeded(unreadAt);
    expect(await isUnread(unreadAt)).toBe(true);
    await browser("press", "r");
    await waitFor(`!${unreadExpression(unreadAt)}`);
    expect(
      (await db.conversationMember.findUniqueOrThrow({ where: { id: unread.viewer.id } }))
        .readThroughSequence,
    ).toBeGreaterThanOrEqual(5);
    await browser("press", "r");
    await waitFor(unreadExpression(unreadAt));
    // The row kept the selection through both.
    expect(await evaluate<boolean>(`${seeded}[${unreadAt}].contains(document.activeElement)`)).toBe(
      true,
    );

    // Keys typed in an input inside the list do nothing: no Done, no read, no move.
    const before = await evaluate<string[]>(`${seeded}.map((row) => row.textContent)`);
    await evaluate(`(() => {
      const input = document.createElement("input");
      input.id = "keys-probe";
      ${seeded}[${unreadAt}].append(input);
      input.focus();
      return true;
    })()`);
    for (const key of ["e", "r", "j", "k", "ArrowDown"]) await browser("press", key);
    await Bun.sleep(1_000);
    expect(await evaluate<string>(`document.activeElement?.id ?? ""`)).toBe("keys-probe");
    expect(await evaluate<string[]>(`${seeded}.map((row) => row.textContent)`)).toEqual(before);
    await evaluate(`(document.getElementById("keys-probe")?.remove(), true)`);

    // E marks the selected row Done: it leaves, and the row after it is selected.
    await focusSeeded(0);
    const doneText = await evaluate<string>(`${seeded}[0].textContent`);
    const nextText = await evaluate<string>(
      `${rows}[${await evaluate<number>(focused)} + 1].textContent`,
    );
    await browser("press", "e");
    await waitFor(`!${rows}.some((row) => row.textContent === ${JSON.stringify(doneText)})`);
    expect(await evaluate<string>(`${rows}[${focused}]?.textContent ?? ""`)).toBe(nextText);
    expect(
      await evaluate<number>(
        `${rows}.filter((row) => row.hasAttribute("data-activity-row") && row.querySelector("a").tabIndex === 0).length`,
      ),
    ).toBe(1);
    const done = await db.conversationMember.findMany({
      where: { id: { in: [unread.viewer.id, read.viewer.id] } },
      select: { doneThroughSequence: true },
    });
    expect(done.some((member) => member.doneThroughSequence !== null)).toBe(true);

    // Enter opens the selected row on the page, as a click does.
    expect(await evaluate<string | null>(openParam)).toBeNull();
    await browser("press", "Enter");
    await waitFor(`${openParam} !== null`);
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
