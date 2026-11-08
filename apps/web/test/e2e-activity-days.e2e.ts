import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated, seededUuid } from "./helpers/browser-e2e";
import { rowItems, seedDirectConversation } from "./helpers/activity-inbox-e2e";

/**
 * The Activity list is split by the day of each conversation's latest message (Frank, 11-08, task
 * #24): a heading for today, and one for an older day. Split from `e2e-activity-inbox.e2e.ts`,
 * whose setup it shares. Opt-in like the other browser E2Es. Screenshots go under
 * `.amp/e2e/activity-days/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/activity-days");

test("the list is split by day", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `activity-days-${process.pid}`;
  const { browser, evaluate } = browserSession(browserPath, session);
  /** One seeded row's text and the picture its avatar shows, found by a message it previews. */
  const row = (text: string) =>
    `(() => { const row = [...document.querySelectorAll(${rowItems})].find((item) => item.textContent.includes(${JSON.stringify(text)})); return row ? { text: row.textContent, avatar: row.querySelector("[data-avatar] img")?.getAttribute("src") ?? null } : null; })()`;
  try {
    const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${workspace.slug}`;
    const peer = await db.user.upsert({
      where: { id: seededUuid("e2e-activity-inbox:dm-peer") },
      update: {},
      create: {
        id: seededUuid("e2e-activity-inbox:dm-peer"),
        username: "e2e-activity-dm-peer",
        displayName: "Activity DM Peer",
      },
    });
    await db.workspaceMembership.upsert({
      where: { workspaceId_userId: { workspaceId, userId: peer.id } },
      update: {},
      create: { workspaceId, userId: peer.id },
    });
    /** Posts this run's copy of a seeded message as the conversation's newest. */
    async function post(conversationId: string, key: string, senderMemberId: string, body: string) {
      const id = seededUuid(key);
      await db.message.deleteMany({ where: { id } });
      const newest = await db.message.findFirst({
        where: { conversationId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      await db.message.create({
        data: {
          id,
          conversationId,
          workspaceId,
          senderMemberId,
          body,
          sequence: (newest?.sequence ?? 0) + 1,
        },
      });
      return id;
    }
    // The peer is this test's own, so their DM starts empty and unread on every run. The viewer's
    // DM with themself is theirs: only this test's note is replaced.
    const withPeer = await seedDirectConversation(
      db,
      workspaceId,
      "e2e-activity-inbox:dm",
      peer.id,
    );
    await db.message.deleteMany({ where: { conversationId: withPeer.conversationId } });
    await db.conversationMember.updateMany({
      where: { conversationId: withPeer.conversationId },
      data: { readThroughSequence: 0, unreadFromSequence: null },
    });
    const withSelf = await seedDirectConversation(
      db,
      workspaceId,
      "e2e-activity-inbox:self-dm",
      DEV_BROWSER_USER.id,
    );
    await post(
      withSelf.conversationId,
      "e2e-activity-inbox:dm-note",
      withSelf.members[0]!.id,
      "E2E activity note to self",
    );
    await post(
      withPeer.conversationId,
      "e2e-activity-inbox:dm-hello",
      withPeer.members.find((member) => member.userId === peer.id)!.id,
      "E2E activity DM hello",
    );
    // The note is from three days ago.
    const old = new Date(Date.now() - 3 * 86_400_000);
    await db.message.updateMany({
      where: { conversationId: withSelf.conversationId },
      data: { createdAt: old },
    });
    await mkdir(artifacts, { recursive: true });
    const headings = `[...document.querySelectorAll("[data-activity-list] h2")].map((h) => h.textContent.trim())`;
    const shoot = async (name: string) => {
      await browser("screenshot", join(artifacts, `${name}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await browser("wait", "300");
      await browser("screenshot", join(artifacts, `${name}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    };
    for (const [name, width, height] of [
      ["desktop", "1440", "900"],
      ["phone", "390", "844"],
    ] as const) {
      await browser("set", "viewport", width, height);
      await browser("open", `${origin}${workspacePath}/activity`);
      await browser(
        "wait",
        "--fn",
        `${row("E2E activity DM hello")} !== null && ${row("E2E activity note to self")} !== null && ${pageHydrated}`,
      );
      await browser("wait", "--fn", `${headings}.length > 0`);
      const names = await evaluate<string[]>(headings);
      expect(names).toContain("Today");
      // Three days back is a date, not a word.
      expect(names.some((text) => /^[A-Z][a-z]{2} \d{1,2}$/.test(text))).toBe(true);
      // Under a day's heading a row gives the time of day, never "yesterday" or "3d ago".
      const times = await evaluate<string[]>(
        `[...document.querySelectorAll("[data-activity-list] ol time")].map((t) => t.textContent.trim())`,
      );
      expect(times.length).toBeGreaterThan(0);
      expect(times.every((text) => /^\d{1,2}:\d{2}(\s?[AP]M)?$/i.test(text))).toBe(true);
      await shoot(name);
    }
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 90_000);
