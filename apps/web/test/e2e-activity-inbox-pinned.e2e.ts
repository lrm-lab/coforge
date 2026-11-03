import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated, seededUuid } from "./helpers/browser-e2e";
import {
  inPane,
  openParam,
  pinnedItems,
  rowItems,
  seedChannel,
} from "./helpers/activity-inbox-e2e";

/**
 * The Activity page's Pinned section in a real browser: a pinned channel lists under Pinned,
 * before All conversations, and stays there after Done; it opens beside the list. Split from
 * `e2e-activity-inbox.e2e.ts`, whose setup it shares (`helpers/activity-inbox-e2e.ts`).
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. Screenshots are written
 * under `.amp/e2e/activity-inbox/` (`pinned.png`).
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/activity-inbox");

test("a pinned channel lists under Pinned, before All conversations, and stays there after Done", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `activity-inbox-pinned-${process.pid}`;
  const { browser, evaluate } = browserSession(browserPath, session);
  const channelId = seededUuid("e2e-activity-inbox:pinned-channel");
  /** The text of every row under `selector` that previews this test's messages. */
  const rowsIn = (selector: string) =>
    `[...document.querySelectorAll(${selector})].map((row) => row.textContent).filter((text) => text.includes("E2E pinned"))`;
  try {
    const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${workspace.slug}`;
    // Every run starts unpinned.
    await db.conversationPin.deleteMany({ where: { conversationId: channelId } });
    // A followed thread in the channel, and a newer top-level message that mentions the viewer.
    const { viewer, newestId: helloId } = await seedChannel(db, {
      workspaceId,
      key: "e2e-activity-inbox:pinned-",
      channelName: "e2e-activity-pinned",
      root: "E2E pinned root",
      reply: "E2E pinned reply",
      newest: { key: "hello", body: `<@human:${DEV_BROWSER_USER.id}> E2E pinned hello` },
      mention: "newest",
    });
    await db.conversationPin.create({
      data: { conversationId: channelId, memberId: viewer.id, workspaceId, sortOrder: 0 },
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}${workspacePath}/activity`);
    await browser(
      "wait",
      "--fn",
      `${rowsIn(pinnedItems)}.length === 1 && ${rowsIn(rowItems)}.length === 1 && ${pageHydrated}`,
    );
    // The channel's own row is under Pinned, and only there; its followed thread is below.
    const [pinnedRow] = await evaluate<string[]>(rowsIn(pinnedItems));
    // The bare channel name, with the mention and new-message badges.
    expect(pinnedRow).toContain("e2e-activity-pinned");
    expect(pinnedRow).not.toContain("#e2e-activity-pinned");
    expect(pinnedRow).toContain("@you");
    expect(pinnedRow).toContain("Activity Peer: ");
    expect(pinnedRow).toContain("E2E pinned hello");
    expect(pinnedRow).toContain("1 new");
    const [threadRow] = await evaluate<string[]>(rowsIn(rowItems));
    expect(threadRow).toContain("E2E pinned root");
    expect(threadRow).toContain("#e2e-activity-pinned · ");
    expect(threadRow).not.toContain("E2E pinned hello");
    // Pinned, its rows, then All conversations and the rest of the list.
    expect(
      await evaluate<boolean>(`(() => {
        const pinned = document.querySelector('ol[aria-label="Pinned"]');
        const [pinnedHeading, allHeading] = pinned.parentElement.querySelectorAll(":scope > h2");
        if (pinnedHeading?.textContent.trim() !== "Pinned") return false;
        if (allHeading?.textContent.trim() !== "All conversations") return false;
        const all = document.querySelector('ol[aria-label="Activity"]');
        const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        return follows(pinnedHeading, pinned) && follows(pinned, allHeading) && follows(allHeading, all);
      })()`),
    ).toBe(true);
    await browser("screenshot", join(artifacts, "pinned.png"));

    // Mentions has no Pinned section: the pinned channel lists among its rows.
    await browser("find", "role", "tab", "click", "--name", "Mentions");
    await browser("wait", "--fn", `location.search.includes("filter=mentions")`);
    await browser(
      "wait",
      "--fn",
      `${rowsIn(rowItems)}.some((text) => text.includes("E2E pinned hello"))`,
    );
    expect(
      await evaluate<boolean>(`document.querySelector('ol[aria-label="Pinned"]') === null`),
    ).toBe(true);
    await browser("find", "role", "tab", "click", "--name", "All");
    await browser("wait", "--fn", `${rowsIn(pinnedItems)}.length === 1`);

    // Done keeps a pinned row under Pinned. Done reads the row too, and Pinned keeps its badge
    // until the refetch, so the badge leaving means the server took the Done.
    await evaluate(`(() => {
      const row = [...document.querySelectorAll(${pinnedItems})].find((item) =>
        item.textContent.includes("E2E pinned hello"));
      row.querySelector('[aria-label="Mark as Done"]').click();
      return true;
    })()`);
    await browser(
      "wait",
      "--fn",
      `${rowsIn(pinnedItems)}.length === 1 && !${rowsIn(pinnedItems)}[0].includes("1 new")`,
    );
    expect(await evaluate<boolean>(`!document.querySelector('[role="alert"]')`)).toBe(true);
    await browser("reload");
    await browser("wait", "--fn", `${rowsIn(pinnedItems)}.length === 1 && ${pageHydrated}`);
    expect((await evaluate<string[]>(rowsIn(pinnedItems)))[0]).toContain("E2E pinned hello");
    expect(await evaluate<string[]>(rowsIn(rowItems))).toEqual([
      expect.stringContaining("E2E pinned root"),
    ]);

    // A pinned row opens beside the list and is marked as the open one. Its preview's text runs on
    // from a mention chip, so the row's link is clicked rather than an element with that text.
    await evaluate(`[...document.querySelectorAll(${pinnedItems})]
      .find((item) => item.textContent.includes("E2E pinned hello"))
      .querySelector("a")
      .click() ?? true`);
    await browser("wait", "--fn", `${openParam} === ${JSON.stringify(`channel:${channelId}`)}`);
    await browser("wait", "--fn", inPane(helloId));
    await browser(
      "wait",
      "--fn",
      `[...document.querySelectorAll(${pinnedItems})].some((item) => item.querySelector("a")?.getAttribute("aria-current") === "true" && item.textContent.includes("E2E pinned hello"))`,
    );
  } finally {
    await browser("close").catch(() => undefined);
    // Leave the dev user's sidebar without this test's pin.
    await db.conversationPin
      .deleteMany({ where: { conversationId: channelId } })
      .catch(() => undefined);
    await db.$disconnect();
  }
}, 90_000);
