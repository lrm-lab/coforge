import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { daysNamed, seedChannel } from "./helpers/activity-inbox-e2e";

/**
 * Activity's rows stay the same elements once the page hydrates (task #64). Before hydration no
 * day can be named, so the list is one undated section; after it, the rows group under their days.
 * When the sections were keyed by their label, that rename remounted every row, and a press that
 * began on a row before the remount and ended after it produced no click: on a slow machine the
 * row did not open. An observer installed before the page's scripts records every row element
 * removed from the page; none of the first day's may be, and the first row seen stays connected.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel is seeded by
 * key, so a rerun replaces its rows.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/activity-rows-stable");

const OBSERVE_ROWS = `(() => {
  window.__rowsRemoved = [];
  new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1) continue;
        const rows = node.matches("li[data-activity-row]")
          ? [node]
          : [...node.querySelectorAll("li[data-activity-row]")];
        for (const row of rows) window.__rowsRemoved.push(row.getAttribute("data-activity-row"));
      }
    if (!window.__firstRow) window.__firstRow = document.querySelector("li[data-activity-row]");
  }).observe(document, { childList: true, subtree: true });
})();`;

test("Activity keeps its row elements when the page hydrates and names the days", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(
    browserPath,
    `activity-rows-stable-${process.pid}`,
  );
  try {
    const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    await seedChannel(db, {
      workspaceId,
      key: "rows-stable",
      channelName: "e2e-activity-rows-stable",
      root: "E2E rows-stable root",
      reply: "E2E rows-stable reply",
      newest: { key: "newest", body: "E2E rows-stable newest" },
      mention: "newest",
    });
    await mkdir(artifacts, { recursive: true });
    const observer = join(artifacts, "observe-rows.js");
    await Bun.write(observer, OBSERVE_ROWS);

    // The flag precedes the command (see e2e-channel-members-page): the script runs on every open.
    await browser("--init-script", observer, "set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/activity`);
    await waitFor(
      `${pageHydrated} && document.body.textContent.includes("E2E rows-stable newest") && ${daysNamed}`,
      60_000,
    );
    // The day headings are up; give any late re-render time to land.
    await Bun.sleep(1_000);
    // The first day's rows (today's: the seeded channel's) are the ones that were on screen; a row
    // from an earlier day moves into that day's own list, which is new, and remounts once.
    const firstDay = `[...document.querySelectorAll("[data-activity-list] ol")].find((list) => !["Pinned", "Waiting on you"].includes(list.getAttribute("aria-label")))`;
    const firstDayIds = await evaluate<string[]>(
      `[...${firstDay}.querySelectorAll("li[data-activity-row]")].map((row) => row.getAttribute("data-activity-row"))`,
    );
    expect(firstDayIds.length).toBeGreaterThan(0);
    const removed = await evaluate<string[]>("window.__rowsRemoved");
    expect(firstDayIds.filter((id) => removed.includes(id))).toEqual([]);
    expect(await evaluate<boolean>("Boolean(window.__firstRow?.isConnected)")).toBe(true);
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
