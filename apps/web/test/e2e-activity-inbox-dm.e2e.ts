import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { personAvatarUrl } from "#src/lib/person-picture";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated, seededUuid } from "./helpers/browser-e2e";
import {
  currentRow,
  inPane,
  openParam,
  rowItems,
  seedDirectConversation,
} from "./helpers/activity-inbox-e2e";

/**
 * The Activity page's rows for direct messages in a real browser: one with a member and the
 * one with themself list with the member's face and name. Split from `e2e-activity-inbox.e2e.ts`,
 * whose setup it shares (`helpers/activity-inbox-e2e.ts`).
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. Screenshots are written
 * under `.amp/e2e/activity-inbox/` (`member-dm.png`).
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/activity-inbox");

test("a direct message with a member, and the one with themself, list with the member's face and name", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `activity-inbox-dm-${process.pid}`;
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
    const viewer = await db.user.findUniqueOrThrow({ where: { id: DEV_BROWSER_USER.id } });
    const viewerName = viewer.displayName?.trim() || viewer.username;
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
    const helloId = await post(
      withPeer.conversationId,
      "e2e-activity-inbox:dm-hello",
      withPeer.members.find((member) => member.userId === peer.id)!.id,
      "E2E activity DM hello",
    );
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}${workspacePath}/activity`);
    await browser(
      "wait",
      "--fn",
      `${row("E2E activity DM hello")} !== null && ${row("E2E activity note to self")} !== null && ${pageHydrated}`,
    );
    // The member's DM goes by their name and face, unread; the viewer's own by theirs, "(you)".
    // The title is the bare name, without an @.
    const dm = await evaluate<{ text: string; avatar: string | null }>(
      row("E2E activity DM hello"),
    );
    expect(dm.text).not.toContain("@Activity DM Peer");
    expect(dm.text).toContain("1 new");
    expect(dm.text).toContain("Activity DM Peer: E2E activity DM hello");
    // A member with no picture shows the cartoon person their id chooses.
    expect(dm.avatar).toBe(personAvatarUrl(peer.id, null));
    const self = await evaluate<{ text: string; avatar: string | null }>(
      row("E2E activity note to self"),
    );
    expect(self.text).toContain(`${viewerName} (you)`);
    expect(self.text).not.toContain(`@${viewerName}`);
    expect(self.text).not.toMatch(/\d+ new/);
    expect(self.avatar).not.toBeNull();
    await browser("screenshot", join(artifacts, "member-dm.png"));

    // Opening the row shows the DM beside the list, at the unread message, and reads it.
    await browser("find", "text", "E2E activity DM hello", "click");
    await browser(
      "wait",
      "--fn",
      `${openParam} === ${JSON.stringify(`dm:${withPeer.conversationId}`)}`,
    );
    await browser("wait", "--fn", inPane(helloId));
    expect(await evaluate<string>("location.pathname")).toBe(`${workspacePath}/activity`);
    expect(await evaluate<string | null>(currentRow)).toContain("E2E activity DM hello");
    await browser("open", `${origin}${workspacePath}/activity`);
    await browser("wait", "--fn", `${row("E2E activity DM hello")} !== null && ${pageHydrated}`);
    expect((await evaluate<{ text: string }>(row("E2E activity DM hello"))).text).not.toContain(
      "1 new",
    );
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 90_000);
