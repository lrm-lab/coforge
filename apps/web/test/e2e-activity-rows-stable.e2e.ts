import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";
import { daysNamed, seedChannel } from "./helpers/activity-inbox-e2e";

/**
 * Activity's rows stay the same elements once the page hydrates (task #64). Before hydration no
 * day can be named, so the list is one undated section; after it, the rows group under their days.
 * When the sections were keyed by their label, that rename remounted every row, and a press that
 * began on a row before the remount and ended after it produced no click: on a slow machine the
 * row did not open. An observer installed before the page's scripts records every row element
 * removed from the page; none of the first day's may be, and the first row seen stays connected.
 * Then, with the zone the page recorded in its cookie, the server names the days itself (task
 * #68): no undated list, no row replaced, no hydration error, in English and in Chinese.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel is seeded by
 * key, so a rerun replaces its rows.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/activity-rows-stable");

const OBSERVE_ROWS = `(() => {
  window.__rowsRemoved = [];
  window.__errors = [];
  const consoleError = console.error;
  console.error = (...args) => {
    window.__errors.push(args.map(String).join(" ").slice(0, 300));
    consoleError(...args);
  };
  addEventListener("error", (event) => window.__errors.push("error: " + event.message));
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
    // The undated list (before the days are named).
    if (document.querySelector("[data-activity-list] ol[data-undated]"))
      window.__undated = true;
  }).observe(document, { childList: true, subtree: true });
})();`;

test("Activity keeps its row elements when the page hydrates and names the days", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(
    browserPath,
    `activity-rows-stable-${process.pid}`,
  );
  try {
    const { workspaceId, workspace } = await devBrowserWorkspace(db);
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

    // Once the page has recorded the browser's zone in its cookie, the server knows it and names
    // the days itself (task #68): the list never shows undated, no row is ever replaced, and the
    // hydrating browser renders what the server sent, in either language.
    const zone = await evaluate<string>("Intl.DateTimeFormat().resolvedOptions().timeZone");
    expect(await evaluate<string>("document.cookie")).toContain(
      `coforge_tz=${encodeURIComponent(zone)}`,
    );
    for (const locale of ["en", "zh-CN"]) {
      await browser("open", `${origin}/${locale}/w/${workspace.slug}/activity`);
      await waitFor(
        `${pageHydrated} && document.body.textContent.includes("E2E rows-stable newest")`,
        60_000,
      );
      await Bun.sleep(1_000);
      // React reports a hydration mismatch (#418 text, #425 attribute, #423 the fallback to a
      // client render) as an uncaught error; the page records every one from its first script.
      expect(
        (await evaluate<string[]>("window.__errors")).filter((error) =>
          /Minified React error #(418|423|425)|hydrat/i.test(error),
        ),
      ).toEqual([]);
      expect(await evaluate<boolean>("Boolean(window.__undated)")).toBe(false);
      expect(await evaluate<string[]>("window.__rowsRemoved")).toEqual([]);
    }
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
