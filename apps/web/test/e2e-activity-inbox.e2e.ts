import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  browserSession,
  devBrowserWorkspace,
  elementAtRest,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";
import {
  activeCount,
  currentRow,
  filterMenuItems,
  filterTriggerSelector,
  inPane,
  listColumnWidth,
  menuItemLabel,
  openParam,
  pane,
  paneTabsShown,
  rightClickRow,
  rowItems,
  seedChannel,
  seedQuietThread,
  selectDesktopFilter,
  shownInPane,
  waitFor,
} from "./helpers/activity-inbox-e2e";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/activity-inbox");

test("the Activity page lists, filters, marks Done and opens inbox items", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `activity-inbox-${process.pid}`;
  const { browser, evaluate } = browserSession(browserPath, session);
  const seededRows = `[...document.querySelectorAll(${rowItems})]
    .map((row) => row.textContent + " " + [...row.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label")).join(" "))
    .filter((text) => text.includes("e2e-activity-inbox"))`;
  try {
    const { workspaceId, workspace } = await devBrowserWorkspace(db);
    const workspacePath = `/en/w/${workspace.slug}`;
    const { channelId, viewer, rootId, replyId, newestId } = await seedChannel(db, {
      workspaceId,
      key: "e2e-activity-inbox:",
      channelName: "e2e-activity-inbox",
      root: "E2E activity root",
      reply: `<@human:${DEV_BROWSER_USER.id}> E2E activity **reply** with \`code\``,
      newest: { key: "unread", body: "E2E activity unread" },
      mention: "reply",
    });
    const { rootId: quietRootId, newestId: quietNewestId } = await seedQuietThread(db, workspaceId);
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}${workspacePath}/activity`);
    await browser("wait", "--fn", `${seededRows}.length === 2 && ${pageHydrated}`);
    const rows = await evaluate<string[]>(seededRows);
    expect(rows[0]).toContain("e2e-activity-inbox");
    expect(rows[0]).not.toContain("#e2e-activity-inbox");
    expect(rows[0]).toContain("1 new");
    expect(rows[0]).toContain("Activity Peer: E2E activity unread");
    expect(rows[1]).toContain("E2E activity root");
    expect(rows[1]).toContain("@you");
    expect(rows[1]).toContain("1 new");
    expect(rows[1]).toMatch(/e2e-activity-inbox\s*Activity Peer: /);
    expect(rows[1]).not.toContain("#e2e-activity-inbox");
    const todayTimes = `[...document.querySelectorAll('ol[aria-label="Today"] > li')].filter((row) => row.textContent.includes("E2E quiet root")).map((row) => row.querySelector("time")?.textContent.trim() ?? "")`;
    await browser("wait", "--fn", `${todayTimes}.length === 1`);
    const times = await evaluate<string[]>(todayTimes);
    expect(times[0]).toMatch(/^\d{1,2}:\d{2}(\s?[AP]M)?$/i);
    expect(await evaluate<boolean>(`${pane} === null`)).toBe(true);
    const splitWidth = await evaluate<number>(listColumnWidth);
    expect(splitWidth / (await evaluate<number>("innerWidth"))).toBeLessThan(0.5);
    const active = await evaluate<number | null>(activeCount);
    expect(active).toBeGreaterThanOrEqual(2);
    const preview = await evaluate<{ strong: string | null; code: string | null }>(`(() => {
      const row = [...document.querySelectorAll(${rowItems})].find((item) =>
        item.textContent.includes("E2E activity root"));
      return {
        strong: row.querySelector("strong")?.textContent ?? null,
        code: row.querySelector("code")?.textContent ?? null,
      };
    })()`);
    expect(preview).toEqual({ strong: "reply", code: "code" });
    const unreadToggleCount = `Number(document.querySelector('[data-activity-list] header button[aria-pressed]')?.textContent?.replace(/\\D/g, "") ?? 0)`;
    const openFilterMenu = async () => {
      await browser("click", filterTriggerSelector);
      await browser("wait", "--fn", `${filterMenuItems}.length === 5`);
    };
    const readFilterCounts = async () => {
      await openFilterMenu();
      const result = await evaluate<Record<string, number>>(
        `Object.fromEntries([...${filterMenuItems}].map((item) => [${menuItemLabel("item")}, Number(item.textContent.replace(/\\D/g, "")) || 0]))`,
      );
      await browser("press", "Escape");
      await browser("wait", "--fn", `document.querySelectorAll('[role="menu"]').length === 0`);
      return result;
    };
    const selectFilter = (name: string) => selectDesktopFilter(browser, evaluate, name);
    const counts = await readFilterCounts();
    expect(Object.keys(counts)).toEqual(["All", "Unread", "Mentions", "Tasks", "Artifacts"]);
    expect(counts.All).toBe(0);
    expect(counts.Unread).toBeGreaterThanOrEqual(2);
    expect(counts.Mentions).toBeGreaterThanOrEqual(1);
    expect(await evaluate<number>(unreadToggleCount)).toBe(counts.Unread);
    await browser("screenshot", join(artifacts, "wide.png"));

    await selectFilter("Mentions");
    await browser("wait", "--fn", `location.search.includes("filter=mentions")`);
    await browser("wait", "--fn", `${seededRows}.length === 1`);
    expect((await evaluate<string[]>(seededRows))[0]).toContain("E2E activity root");
    expect(await readFilterCounts()).toEqual(counts);
    await selectFilter("All");
    await browser("wait", "--fn", `${seededRows}.length === 2`);

    await evaluate(rightClickRow("E2E activity root"));
    await browser("wait", "--fn", `document.querySelectorAll('[role="menuitem"]').length > 0`);
    const menu = await evaluate<string[]>(
      `[...document.querySelectorAll('[role="menuitem"]')].map((item) => ${menuItemLabel("item")})`,
    );
    expect(menu).toEqual(["Mark as read", "Done", "Unfollow thread"]);
    await browser("screenshot", join(artifacts, "row-menu.png"));
    await browser("press", "Escape");
    const noMenu = `document.querySelectorAll('[role="menu"]').length === 0`;
    await browser("wait", "--fn", noMenu);

    const channelMenu = (label: string) =>
      browser("wait", "--fn", noMenu)
        .then(() => evaluate(rightClickRow("E2E activity unread")))
        .then(() =>
          browser(
            "wait",
            "--fn",
            `[...document.querySelectorAll('[role="menuitem"]')].some((item) => ${menuItemLabel("item")} === ${JSON.stringify(label)})`,
          ),
        )
        .then(() =>
          evaluate(`[...document.querySelectorAll('[role="menuitem"]')]
            .find((item) => ${menuItemLabel("item")} === ${JSON.stringify(label)})
            .click() ?? true`),
        );
    const channelRow = `([...document.querySelectorAll(${rowItems})].find((item) => item.textContent.includes("E2E activity unread"))?.textContent ?? "")`;
    await channelMenu("Mark as read");
    await browser("wait", "--fn", `!${channelRow}.includes("1 new")`);
    await browser("wait", "--fn", `${unreadToggleCount} === ${counts.Unread - 1}`);
    await channelMenu("Mark as unread");
    await browser("wait", "--fn", `${channelRow}.includes("1 new")`);
    await browser("wait", "--fn", `${unreadToggleCount} === ${counts.Unread}`);
    expect(await evaluate<boolean>(`!document.querySelector('[role="alert"]')`)).toBe(true);

    await evaluate(`(() => {
      const row = [...document.querySelectorAll(${rowItems})].find((item) =>
        item.textContent.includes("E2E activity unread"));
      row.querySelector('[aria-label="Mark as done"]').click();
      return true;
    })()`);
    await browser("wait", "--fn", `${seededRows}.length === 1`);
    await browser("wait", "--fn", `${unreadToggleCount} === ${counts.Unread - 1}`);
    await browser("wait", "--fn", `${activeCount} === ${active! - 1}`);
    await browser("reload");
    await browser("wait", "--fn", `${seededRows}.length === 1 && ${pageHydrated}`);
    expect((await evaluate<string[]>(seededRows))[0]).toContain("E2E activity root");

    expect(await evaluate<string | null>(openParam)).toBeNull();
    expect(await evaluate<string | null>(currentRow)).toBeNull();
    await db.conversationMember.update({
      where: { id: viewer.id },
      data: { readThroughSequence: 0, unreadFromSequence: null },
    });
    await db.threadRead.deleteMany({ where: { memberId: viewer.id, rootMessageId: rootId } });
    await browser("find", "text", "E2E activity root", "click");
    await browser("wait", "--fn", `location.search.includes("threadRootId=${rootId}")`);
    await browser("wait", "--fn", inPane(replyId));
    expect(await evaluate<string>("location.pathname")).toBe(`${workspacePath}/activity`);
    expect(await evaluate<string | null>(openParam)).toBe(`thread:channel:${channelId}`);
    expect(await evaluate<string | null>(currentRow)).toContain("E2E activity root");
    expect(await evaluate<boolean>(shownInPane(rootId))).toBe(true);
    expect(await evaluate<boolean>(shownInPane(newestId))).toBe(false);
    expect(await evaluate<boolean>(paneTabsShown)).toBe(false);
    expect(await evaluate<boolean>(`${pane} !== null`)).toBe(true);
    expect(await evaluate<number>(listColumnWidth)).toBe(splitWidth);
    await browser("screenshot", join(artifacts, "wide-open.png"));
    await waitFor(async () => {
      const read = await db.threadRead.findUnique({
        where: { memberId_rootMessageId: { memberId: viewer.id, rootMessageId: rootId } },
      });
      return (read?.readThroughSequence ?? 0) >= 2;
    });
    expect(
      (await db.conversationMember.findUniqueOrThrow({ where: { id: viewer.id } }))
        .readThroughSequence,
    ).toBe(0);
    await selectFilter("Mentions");
    await browser("wait", "--fn", `location.search.includes("filter=mentions")`);
    expect(await evaluate<string | null>(openParam)).toBe(`thread:channel:${channelId}`);
    expect(await evaluate<boolean>(inPane(replyId))).toBe(true);
    await selectFilter("All");
    await browser("wait", "--fn", `!location.search.includes("filter=")`);
    expect(await evaluate<string | null>(openParam)).toBe(`thread:channel:${channelId}`);
    await browser("reload");
    await browser("wait", "--fn", `${inPane(replyId)} && ${pageHydrated}`);
    await browser("wait", "--fn", `(${currentRow})?.includes("E2E activity root") === true`);
    expect(await evaluate<string | null>(openParam)).toBe(`thread:channel:${channelId}`);
    expect(await evaluate<boolean>(shownInPane(newestId))).toBe(false);
    expect(
      (await db.conversationMember.findUniqueOrThrow({ where: { id: viewer.id } }))
        .readThroughSequence,
    ).toBe(0);
    const profilePanel = `${pane}?.querySelector('aside[aria-label="Activity Peer"]')`;
    await browser("find", "role", "button", "click", "--name", "Open Activity Peer's profile");
    await browser("wait", "--fn", `(${profilePanel})?.getClientRects().length > 0`);
    expect(await evaluate<string | null>(openParam)).toBe(`thread:channel:${channelId}`);
    expect(await evaluate<boolean>(shownInPane(newestId))).toBe(false);
    expect(await evaluate<boolean>(paneTabsShown)).toBe(false);
    expect(
      (await db.conversationMember.findUniqueOrThrow({ where: { id: viewer.id } }))
        .readThroughSequence,
    ).toBe(0);
    const activatePaneControl = async (selector: string) => {
      const target = `document.querySelector(${JSON.stringify(selector)})`;
      await browser(
        "wait",
        "--fn",
        `document.querySelectorAll(${JSON.stringify(selector)}).length === 1 && ${elementAtRest(target)}`,
      );
      await browser("focus", selector);
      await browser("press", "Enter");
    };
    await activatePaneControl(
      'section[aria-label="Selected conversation"] aside [aria-label="Close"]',
    );
    await browser("wait", "--fn", `${shownInPane(rootId)} && !(${profilePanel})`);
    expect(await evaluate<boolean>(shownInPane(newestId))).toBe(false);
    await activatePaneControl(
      'section[aria-label="Selected conversation"] [aria-label="Thread actions"]',
    );
    await browser("find", "role", "menuitem", "click", "--name", "View in channel");
    await browser("wait", "--fn", `${openParam} === ${JSON.stringify(`channel:${channelId}`)}`);
    expect(await evaluate<boolean>(`location.search.includes("threadRootId")`)).toBe(false);
    expect(await evaluate<string>("location.hash")).toBe("");
    await browser("wait", "--fn", `${shownInPane(newestId)} && ${paneTabsShown}`);
    await waitFor(
      async () =>
        (await db.conversationMember.findUniqueOrThrow({ where: { id: viewer.id } }))
          .readThroughSequence === 3,
    );
    await evaluate(`[...document.querySelectorAll(${rowItems})]
      .find((item) => item.textContent.includes("E2E activity root"))
      .querySelector("a")
      .click() ?? true`);
    await browser(
      "wait",
      "--fn",
      `${openParam} === ${JSON.stringify(`thread:channel:${channelId}`)}`,
    );
    await browser("wait", "--fn", inPane(replyId));
    await browser("click", '[aria-label="Close thread"]');
    await browser("wait", "--fn", `${pane} === null && ${openParam} === null`);

    await browser("open", `${origin}${workspacePath}/activity`);
    await browser(
      "wait",
      "--fn",
      `document.body.textContent.includes("E2E quiet root") && ${pageHydrated}`,
    );
    expect(await evaluate<boolean>(`${pane} === null`)).toBe(true);
    await browser("find", "text", "E2E quiet root", "click");
    await browser("wait", "--fn", `location.search.includes("threadRootId=${quietRootId}")`);
    await browser(
      "wait",
      "--fn",
      `(() => {
        const row = document.getElementById("message-${quietNewestId}");
        let pane = row?.parentElement;
        while (pane && !(pane.scrollHeight > pane.clientHeight && getComputedStyle(pane).overflowY !== "visible"))
          pane = pane.parentElement;
        if (!row || !pane || pane.scrollTop === 0) return false;
        const rowBox = row.getBoundingClientRect();
        const paneBox = pane.getBoundingClientRect();
        return rowBox.top >= paneBox.top && rowBox.bottom <= paneBox.bottom;
      })()`.replace(/\n\s*/g, " "),
    );
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 90_000);
