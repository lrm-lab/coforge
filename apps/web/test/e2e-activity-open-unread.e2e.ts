import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { inPane, waitFor } from "./helpers/activity-inbox-e2e";
import { dividerBetween, inView, postLive, row, seedChannel } from "./helpers/open-unread-e2e";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";

/**
 * A channel and a thread opened from Activity land on their first unread message under the "New
 * messages" divider (task #358): the row leaves the read to the pane, which reads once the divider
 * is placed, and the divider skips the viewer's own message past their cursor, as the server's
 * unread count does. Each has, past the viewer's cursor, the viewer's own message and then the
 * peer's.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channels, their peer
 * and their messages are seeded deterministically and reset on every run. Screenshots of each
 * open are written under `.amp/e2e/activity-open-unread/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/activity-open-unread");

test("a channel and a thread opened from Activity land on the first message unread for the viewer", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `activity-open-unread-${process.pid}`);
  try {
    const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const activity = `${origin}/en/w/${workspace.slug}/activity`;
    // Read through the first message; the viewer then wrote, and the peer twice after them.
    const channel = await seedChannel(db, workspaceId, "e2e-open-unread-channel", 1, [
      { from: "peer", body: "E2E open-unread read" },
      { from: "viewer", body: "E2E open-unread own" },
      { from: "peer", body: "E2E open-unread first" },
      { from: "peer", body: "E2E open-unread newest" },
    ]);
    // The same in a followed thread whose root is read: the viewer read its first reply.
    const thread = await seedChannel(db, workspaceId, "e2e-open-unread-thread", 2, [
      { from: "peer", body: "E2E open-unread thread root" },
      { from: "peer", body: "E2E open-unread reply read", rootIndex: 0 },
      { from: "viewer", body: "E2E open-unread own reply", rootIndex: 0 },
      { from: "peer", body: "E2E open-unread first reply", rootIndex: 0 },
    ]);
    const threadRoot = thread.ids[0]!;
    const threadRef = {
      memberId: thread.viewer.id,
      rootMessageId: threadRoot,
      conversationId: thread.channelId,
      workspaceId,
    };
    await db.threadFollow.create({ data: threadRef });
    await db.threadRead.create({ data: { ...threadRef, readThroughSequence: 2 } });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", activity);
    await browser(
      "wait",
      "--fn",
      `${row("E2E open-unread newest")} !== null && ${row("E2E open-unread thread root")} !== null && ${pageHydrated}`,
    );
    // Two new: the viewer's own message is not one.
    expect(await evaluate<string>(row("E2E open-unread newest"))).toContain("2 new");

    await browser("find", "text", "E2E open-unread newest", "click");
    await browser("wait", "--fn", inPane(channel.ids[2]!));
    await browser("wait", "--fn", dividerBetween(channel.ids[1]!, channel.ids[2]!));
    await browser("screenshot", join(artifacts, "channel.png"));
    // The pane reads the channel, after its divider is placed.
    await waitFor(
      async () =>
        (await db.conversationMember.findUniqueOrThrow({ where: { id: channel.viewer.id } }))
          .readThroughSequence === 4,
    );

    await browser("find", "text", "E2E open-unread thread root", "click");
    await browser("wait", "--fn", `location.search.includes("threadRootId=${threadRoot}")`);
    await browser("wait", "--fn", inPane(thread.ids[3]!));
    await browser("wait", "--fn", dividerBetween(thread.ids[2]!, thread.ids[3]!));
    await browser("screenshot", join(artifacts, "thread.png"));
    await waitFor(
      async () =>
        (
          await db.threadRead.findUniqueOrThrow({
            where: {
              memberId_rootMessageId: { memberId: thread.viewer.id, rootMessageId: threadRoot },
            },
          })
        ).readThroughSequence === 4,
    );

    // Back on Activity, both rows are read.
    await browser("open", activity);
    await browser("wait", "--fn", `${row("E2E open-unread newest")} !== null && ${pageHydrated}`);
    expect(await evaluate<string>(row("E2E open-unread newest"))).not.toMatch(/\d+ new/);
    expect(await evaluate<string>(row("E2E open-unread thread root"))).not.toMatch(/\d+ new/);
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 90_000);

test("a channel with a mention already read opens on its new unread message, not the mention", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `activity-open-mention-${process.pid}`);
  try {
    const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const viewer = await db.user.findUniqueOrThrow({ where: { id: DEV_BROWSER_USER.id } });
    // A screenful and more of read messages, the second of them mentioning the viewer, then one
    // unread message (QA's #video-gen, task #358).
    const read = Array.from({ length: 40 }, (_, index) => ({
      from: "peer" as const,
      body: `E2E open-mention read ${index + 1}`,
    }));
    const channel = await seedChannel(db, workspaceId, "e2e-open-unread-mention", read.length, [
      ...read,
      { from: "peer", body: "E2E open-mention unread" },
    ]);
    const mention = channel.ids[1]!;
    const unread = channel.ids.at(-1)!;
    await db.messageMention.create({
      data: {
        messageId: mention,
        memberId: channel.viewer.id,
        conversationId: channel.channelId,
        workspaceId,
        kind: "user",
        actorId: viewer.id,
        handle: viewer.username,
      },
    });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    // On Activity's Unread view, where the card leaves the list once the pane has read it.
    await browser("open", `${origin}/en/w/${workspace.slug}/activity?filter=unread`);
    await browser("wait", "--fn", `${row("E2E open-mention unread")} !== null && ${pageHydrated}`);

    await browser("find", "text", "E2E open-mention unread", "click");
    await browser("wait", "--fn", inPane(unread));
    await browser("wait", "--fn", dividerBetween(channel.ids.at(-2)!, unread));
    await browser("wait", "--fn", inView(unread));
    // The pane reads the channel; the divider stays, and the card leaves the Unread view.
    await waitFor(
      async () =>
        (await db.conversationMember.findUniqueOrThrow({ where: { id: channel.viewer.id } }))
          .readThroughSequence ===
        read.length + 1,
    );
    await browser("wait", "1500");
    await browser("screenshot", join(artifacts, "mention-read.png"));
    await browser("wait", "--fn", dividerBetween(channel.ids.at(-2)!, unread));
    expect(await evaluate<boolean>(inView(mention))).toBe(false);
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 90_000);

test("a channel opened again from Activity, with a message that came live since, shows its divider", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser } = browserSession(browserPath, `activity-open-again-${process.pid}`);
  const realtime = new CentrifugoConversationRealtime(createCentrifugoServerApi());
  try {
    const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const read = Array.from({ length: 150 }, (_, index) => ({
      from: "peer" as const,
      body: `E2E open-again read ${index + 1}`,
    }));
    const channel = await seedChannel(db, workspaceId, "e2e-open-unread-again", read.length, [
      ...read,
      { from: "peer", body: "E2E open-again first unread" },
    ]);
    const other = await seedChannel(db, workspaceId, "e2e-open-unread-elsewhere", 0, [
      { from: "peer", body: "E2E open-again elsewhere" },
    ]);
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/activity`);
    await browser(
      "wait",
      "--fn",
      `${row("E2E open-again first unread")} !== null && ${pageHydrated}`,
    );

    // QA's #video-gen (task #358): the viewer reads a channel longer than a page from Activity,
    // opens another conversation, all within the page, and a message comes into the channel
    // meanwhile. Reopened, the pane jumps to it while its stale window refetches.
    await browser("find", "text", "E2E open-again first unread", "click");
    await browser("wait", "--fn", inPane(channel.ids.at(-1)!));
    await waitFor(
      async () =>
        (await db.conversationMember.findUniqueOrThrow({ where: { id: channel.viewer.id } }))
          .readThroughSequence ===
        read.length + 1,
    );
    await browser("find", "text", "E2E open-again elsewhere", "click");
    await browser("wait", "--fn", inPane(other.ids[0]!));
    const later = await postLive(db, realtime, {
      channelId: channel.channelId,
      workspaceId,
      sequence: read.length + 2,
      body: "E2E open-again later unread",
    });
    // QA's Unread view, read afresh: the card names the new message whether or not the list
    // heard it live.
    await browser(
      "eval",
      `[...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.startsWith("Unread")).click()`,
    );
    await browser("wait", "--fn", `${row("E2E open-again later unread")} !== null`);
    // Staging's round trips, not a local server's: every read the reopened pane makes is slow.
    await browser(
      "eval",
      `(() => { const f = window.fetch; window.fetch = (...a) => new Promise((r) => setTimeout(r, 700)).then(() => f(...a)); return true; })()`,
    );
    await browser("find", "text", "e2e-open-unread-again", "click");
    await browser("wait", "--fn", inPane(later));
    // The divider stays over the new message after the pane has read it.
    await waitFor(
      async () =>
        (await db.conversationMember.findUniqueOrThrow({ where: { id: channel.viewer.id } }))
          .readThroughSequence ===
        read.length + 2,
    );
    await browser("wait", "1000");
    await browser("screenshot", join(artifacts, "open-again.png"));
    await browser("wait", "--fn", dividerBetween(channel.ids.at(-1)!, later));
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 90_000);
