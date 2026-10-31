import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated, seededUuid } from "./helpers/browser-e2e";
import { inPane, rowItems, waitFor } from "./helpers/activity-inbox-e2e";

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
const key = "e2e-activity-open-unread:";

/** The divider sits after message `before` and before message `after` in the pane. */
function dividerBetween(before: string, after: string) {
  return `(() => {
    const divider = document.querySelector('[role="separator"][aria-label="New messages"]');
    const rows = [${JSON.stringify(before)}, ${JSON.stringify(after)}].map((id) => document.getElementById("message-" + id));
    if (!divider || !rows[0] || !rows[1]) return false;
    return Boolean(rows[0].compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      Boolean(divider.compareDocumentPosition(rows[1]) & Node.DOCUMENT_POSITION_FOLLOWING);
  })()`;
}

/** The Activity row whose text includes `text`, or null. */
function row(text: string) {
  return `([...document.querySelectorAll(${rowItems})].find((item) => item.textContent.includes(${JSON.stringify(text)}))?.textContent ?? null)`;
}

/**
 * A channel of the viewer and the peer, emptied and filled with `messages` (sequence 1 on), the
 * viewer having read through `readThrough`. A message names its sender, `viewer` or `peer`, and its
 * thread root's index when it is a reply.
 */
async function seedChannel(
  db: PrismaClient,
  workspaceId: string,
  name: string,
  readThrough: number,
  messages: { from: "viewer" | "peer"; body: string; rootIndex?: number }[],
) {
  const peer = await db.user.upsert({
    where: { id: seededUuid(`${key}peer`) },
    update: {},
    create: {
      id: seededUuid(`${key}peer`),
      username: "e2e-open-unread-peer",
      displayName: "Open Unread Peer",
    },
  });
  await db.workspaceMembership.upsert({
    where: { workspaceId_userId: { workspaceId, userId: peer.id } },
    update: {},
    create: { workspaceId, userId: peer.id },
  });
  const channelId = seededUuid(`${key}${name}`);
  await db.conversation.upsert({
    where: { id: channelId },
    update: { archivedAt: null },
    create: { id: channelId, workspaceId, channelName: name },
  });
  await db.message.deleteMany({ where: { conversationId: channelId } });
  const [viewer, other] = await Promise.all(
    [DEV_BROWSER_USER.id, peer.id].map((userId) =>
      db.conversationMember.upsert({
        where: { conversationId_userId: { conversationId: channelId, userId } },
        update: {
          leftAt: null,
          hiddenAt: null,
          readThroughSequence: readThrough,
          doneThroughSequence: null,
          unreadFromSequence: null,
        },
        create: {
          conversationId: channelId,
          workspaceId,
          userId,
          readThroughSequence: readThrough,
        },
      }),
    ),
  );
  const ids = messages.map((_, index) => seededUuid(`${key}${name}:${index}`));
  for (const [index, message] of messages.entries())
    await db.message.create({
      data: {
        id: ids[index]!,
        conversationId: channelId,
        workspaceId,
        sequence: index + 1,
        body: message.body,
        senderMemberId: (message.from === "viewer" ? viewer : other)!.id,
        threadRootId: message.rootIndex === undefined ? null : ids[message.rootIndex]!,
      },
    });
  return { channelId, viewer: viewer!, ids };
}

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
