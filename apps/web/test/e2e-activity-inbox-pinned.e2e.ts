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
  seedChannel,
} from "./helpers/activity-inbox-e2e";

const todayRows = JSON.stringify('ol[aria-label="Today"] > li');

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/activity-inbox");

test("a pinned channel lists under Pinned, before the day's rows; Done takes it out; new activity lists it again", async () => {
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
    await browser(
      "wait",
      "--fn",
      `${rowsIn(pinnedItems)}.length === 1 && ${rowsIn(todayRows)}.length === 1 && ${pageHydrated}`,
    );
    const [pinnedRow] = await evaluate<string[]>(rowsIn(pinnedItems));
    expect(pinnedRow).toContain("e2e-activity-pinned");
    expect(pinnedRow).not.toContain("#e2e-activity-pinned");
    expect(pinnedRow).toContain("@you");
    expect(pinnedRow).toContain("Activity Peer: ");
    expect(pinnedRow).toContain("E2E pinned hello");
    expect(pinnedRow).toContain("1 new");
    const [threadRow] = await evaluate<string[]>(rowsIn(todayRows));
    expect(threadRow).toContain("E2E pinned root");
    expect(threadRow).toContain("e2e-activity-pinned · ");
    expect(threadRow).not.toContain("#e2e-activity-pinned");
    expect(threadRow).not.toContain("E2E pinned hello");
    expect(
      await evaluate<boolean>(`(() => {
        const pinned = document.querySelector('ol[aria-label="Pinned"]');
        const pinnedHeading = [...pinned.parentElement.querySelectorAll(":scope > h2")]
          .find((heading) => heading.textContent.trim() === "Pinned");
        if (!pinnedHeading) return false;
        const today = document.querySelector('ol[aria-label="Today"]');
        if (!today) return false;
        const dayHeading = today.previousElementSibling;
        if (dayHeading?.tagName !== "H2" || dayHeading.textContent.trim() !== "Today") return false;
        const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        return follows(pinnedHeading, pinned) && follows(pinned, dayHeading) && follows(dayHeading, today);
      })()`),
    ).toBe(true);
    await browser("screenshot", join(artifacts, "pinned.png"));

    await browser("find", "role", "tab", "click", "--name", "Mentions");
    await browser("wait", "--fn", `location.search.includes("filter=mentions")`);
    await browser(
      "wait",
      "--fn",
      `${rowsIn(todayRows)}.some((text) => text.includes("E2E pinned hello"))`,
    );
    expect(
      await evaluate<boolean>(`document.querySelector('ol[aria-label="Pinned"]') === null`),
    ).toBe(true);
    await browser("find", "role", "tab", "click", "--name", "All");
    await browser("wait", "--fn", `${rowsIn(pinnedItems)}.length === 1`);
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
    await browser(
      "wait",
      "--fn",
      `${rowsIn(pinnedItems)}.length === 1 && ${rowsIn(todayRows)}.length > 0 && ${pageHydrated}`,
    );
    expect((await evaluate<string[]>(rowsIn(pinnedItems)))[0]).toContain("E2E pinned again");
    expect(await evaluate<number>(activeCount)).toBe(active);
    expect(await evaluate<string[]>(rowsIn(todayRows))).toEqual([
      expect.stringContaining("E2E pinned root"),
    ]);

    await evaluate(`[...document.querySelectorAll(${pinnedItems})]
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
      const list = document.querySelector(${todayRows})?.closest("ol")?.parentElement;
      const titles = [...document.querySelectorAll(${todayRows})]
        .filter((item) => /E2E pinned|e2e-activity-pinned/.test(item.textContent))
        .map((item) => Math.round(item.querySelector("a .truncate")?.getBoundingClientRect().width ?? 0));
      const tabs = document.querySelector('[role="tablist"][aria-label="Filter activity"]');
      const edge = document.querySelector('[data-activity-list] > [role="separator"]').getBoundingClientRect().left;
      const tabsPastEdge = Math.round(Math.max(...[...tabs.querySelectorAll('[role="tab"]')].map((tab) => tab.getBoundingClientRect().right)) - edge);
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
