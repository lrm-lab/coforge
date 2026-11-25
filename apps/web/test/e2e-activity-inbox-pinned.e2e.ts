import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
  seededUuid,
} from "./helpers/browser-e2e";
import {
  activeCount,
  inPane,
  openParam,
  pinnedItems,
  rightClickRow,
  seedChannel,
  selectDesktopFilter,
} from "./helpers/activity-inbox-e2e";

const unreadRows = JSON.stringify('ol[aria-label="Unread"] > li');
const allRows = JSON.stringify("[data-activity-row]");
const todayRows = JSON.stringify('ol[aria-label="Today"] > li');

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/activity-inbox");

test("an unread pin lists once under Unread, moves to Pinned on read and returns to Unread on new activity", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `activity-inbox-pinned-${process.pid}`;
  const { browser, evaluate } = browserSession(browserPath, session);
  const rowsIn = (selector: string) =>
    `[...document.querySelectorAll(${selector})].map((row) => row.textContent + " " + [...row.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label")).join(" ")).filter((text) => text.includes("E2E pinned"))`;
  let channelId = "";
  try {
    const { workspaceId, workspace } = await devBrowserWorkspace(db);
    const workspacePath = `/en/w/${workspace.slug}`;
    const seeded = await seedChannel(db, {
      workspaceId,
      key: "e2e-activity-inbox:pinned-",
      channelName: "e2e-activity-pinned",
      root: "E2E pinned root",
      reply: "E2E pinned reply",
      newest: { key: "hello", body: `<@human:${DEV_BROWSER_USER.id}> E2E pinned hello` },
      mention: "newest",
    });
    channelId = seeded.channelId;
    const { viewer, newestId: helloId } = seeded;
    await db.conversationPin.deleteMany({ where: { conversationId: channelId } });
    await db.conversationPin.create({
      data: { conversationId: channelId, memberId: viewer.id, workspaceId, sortOrder: 0 },
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}${workspacePath}/activity`);
    await browser("wait", "--fn", `${rowsIn(unreadRows)}.length === 2 && ${pageHydrated}`);
    expect(await evaluate<string[]>(rowsIn(pinnedItems))).toEqual([]);
    const unread = await evaluate<string[]>(rowsIn(unreadRows));
    const pinnedRow = unread.find((row) => row.includes("E2E pinned hello"));
    expect(pinnedRow).toContain("e2e-activity-pinned");
    expect(pinnedRow).not.toContain("#e2e-activity-pinned");
    expect(pinnedRow).toContain("@you");
    expect(pinnedRow).toContain("Activity Peer: ");
    expect(pinnedRow).toContain("E2E pinned hello");
    expect(pinnedRow).toContain("1 new");
    const threadRow = unread.find((row) => row.includes("E2E pinned root"));
    expect(threadRow).toContain("E2E pinned root");
    expect(threadRow).toMatch(/e2e-activity-pinned\s*Activity Peer: /);
    expect(threadRow).not.toContain("#e2e-activity-pinned");
    expect(threadRow).not.toContain("E2E pinned hello");
    await browser("screenshot", join(artifacts, "pinned.png"));

    await selectDesktopFilter(browser, evaluate, "Mentions");
    await browser("wait", "--fn", `location.search.includes("filter=mentions")`);
    await browser(
      "wait",
      "--fn",
      `${rowsIn(todayRows)}.some((text) => text.includes("E2E pinned hello"))`,
    );
    expect(
      await evaluate<boolean>(`document.querySelector('ol[aria-label="Pinned"]') === null`),
    ).toBe(true);
    await selectDesktopFilter(browser, evaluate, "All");
    await browser("wait", "--fn", `${rowsIn(unreadRows)}.length === 2`);
    await evaluate(rightClickRow("E2E pinned hello"));
    await browser("find", "role", "menuitem", "click", "--name", "Mark as read");
    await browser("wait", "--fn", `${rowsIn(pinnedItems)}.length === 1`);
    expect(await evaluate<string[]>(rowsIn(unreadRows))).toEqual([
      expect.stringContaining("E2E pinned root"),
    ]);
    expect(
      await evaluate<boolean>(
        `Boolean(document.querySelector('ol[aria-label="Unread"]').compareDocumentPosition(document.querySelector('ol[aria-label="Pinned"]')) & Node.DOCUMENT_POSITION_FOLLOWING)`,
      ),
    ).toBe(true);
    const active = await evaluate<number>(activeCount);
    expect(active).toBeGreaterThanOrEqual(2);

    await evaluate(`(() => {
      const row = [...document.querySelectorAll(${pinnedItems})].find((item) =>
        item.textContent.includes("E2E pinned hello"));
      row.querySelector('[aria-label="Mark as done"]').click();
      return true;
    })()`);
    await browser("wait", "--fn", `document.querySelector('ol[aria-label="Pinned"]') === null`);
    expect(await evaluate<boolean>(`!document.querySelector('[role="alert"]')`)).toBe(true);
    expect(await evaluate<number>(activeCount)).toBe(active - 1);
    await browser("reload");
    await browser(
      "wait",
      "--fn",
      `document.querySelector('ol[aria-label="Pinned"]') === null && ${pageHydrated}`,
    );
    expect(await evaluate<string[]>(rowsIn(pinnedItems))).toEqual([]);
    expect(await evaluate<number>(activeCount)).toBe(active - 1);

    const peerMember = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: channelId, userId: seededUuid("e2e-activity-inbox:peer") },
    });
    await db.message.create({
      data: {
        id: seededUuid(`${channelId}:pinned-again`),
        body: "E2E pinned again",
        senderMemberId: peerMember.id,
        conversationId: channelId,
        workspaceId,
        sequence: 4,
      },
    });
    await browser("reload");
    await browser("wait", "--fn", `${rowsIn(unreadRows)}.length === 2 && ${pageHydrated}`);
    expect(await evaluate<string[]>(rowsIn(pinnedItems))).toEqual([]);
    expect(await evaluate<string[]>(rowsIn(unreadRows))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("E2E pinned again"),
        expect.stringContaining("E2E pinned root"),
      ]),
    );
    expect(await evaluate<number>(activeCount)).toBe(active);
    await evaluate(`[...document.querySelectorAll(${unreadRows})]
      .find((item) => item.textContent.includes("E2E pinned again"))
      .querySelector("a")
      .click() ?? true`);
    await browser("wait", "--fn", `${openParam} === ${JSON.stringify(`channel:${channelId}`)}`);
    await browser("wait", "--fn", inPane(helloId));
    await browser(
      "wait",
      "--fn",
      `[...document.querySelectorAll(${pinnedItems})].some((item) => item.querySelector("a")?.getAttribute("aria-current") === "true" && item.textContent.includes("E2E pinned again"))`,
    );
    await evaluate(
      `(document.querySelector('[data-activity-list] > [role="separator"]').focus(), true)`,
    );
    await browser("press", "Home");
    await browser(
      "wait",
      "--fn",
      `(() => { const s = document.querySelector('[data-activity-list] > [role="separator"]'); return s.getAttribute("aria-valuenow") === s.getAttribute("aria-valuemin"); })()`,
    );
    const narrowList = await evaluate<{
      overflow: number;
      titles: number[];
      tabsPastEdge: number;
    }>(`(() => {
      const list = document.querySelector(${allRows})?.closest("ol")?.parentElement;
      const titles = [...document.querySelectorAll(${allRows})]
        .filter((item) => /E2E pinned|e2e-activity-pinned/.test(item.textContent))
        .map((item) => Math.round(item.querySelector("a .truncate")?.getBoundingClientRect().width ?? 0));
      const header = document.querySelector('[data-activity-list] > header');
      const edge = header.getBoundingClientRect().right;
      const tabsPastEdge = Math.round(Math.max(...[...header.querySelectorAll("button")].map((btn) => btn.getBoundingClientRect().right)) - edge);
      return { overflow: list.scrollWidth - list.clientWidth, titles, tabsPastEdge };
    })()`);
    expect(narrowList.overflow).toBeLessThanOrEqual(0);
    expect(narrowList.tabsPastEdge).toBeLessThanOrEqual(0);
    expect(narrowList.titles.length).toBeGreaterThan(0);
    for (const width of narrowList.titles) expect(width).toBeGreaterThanOrEqual(36);
    await browser("screenshot", join(artifacts, "pinned-narrow-open.png"));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("screenshot", join(artifacts, "pinned-narrow-open-dark.png"));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  } finally {
    await browser("close").catch(() => undefined);
    if (channelId)
      await db.conversationPin
        .deleteMany({ where: { conversationId: channelId } })
        .catch(() => undefined);
    await db.$disconnect();
  }
}, 90_000);
