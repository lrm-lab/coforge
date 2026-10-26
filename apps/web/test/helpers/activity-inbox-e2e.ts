import { peopleDirectKey } from "#src/features/conversations/direct-key";
import type { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { seededUuid } from "./browser-e2e";

/**
 * The Activity list's rows, as a selector literal for page expressions. Scoped to the list: a
 * conversation open beside it renders its messages, with the same seeded text, as list items too.
 */
export const rowItems = JSON.stringify('ol[aria-label="Activity"] > li');

/** The Pinned section's rows, as a selector literal for page expressions. */
export const pinnedItems = JSON.stringify('ol[aria-label="Pinned"] > li');

/** The pane beside the list that shows the conversation a row opened. */
export const pane = `document.querySelector('section[aria-label="Selected conversation"]')`;

/** The list's column: its width says whether a pane is beside it. */
export const listColumnWidth = `document.querySelector("[data-activity-list]").getBoundingClientRect().width`;

/** Whether the list's column is mounted but not laid out (a phone with a conversation open). */
export const listHidden = `(() => { const list = document.querySelector("[data-activity-list]"); return Boolean(list) && list.getClientRects().length === 0; })()`;

/** The header's "N active", as its number, or null when it is not shown. */
export const activeCount = `(() => { const text = document.querySelector("[data-activity-active-count]")?.textContent.trim() ?? ""; const match = /^(\\d+) active$/.exec(text); return match ? Number(match[1]) : null; })()`;

/** Whether message `id` is rendered inside the conversation pane (one line: a wait argument). */
export function inPane(id: string) {
  return `(() => { const pane = ${pane}; const row = document.getElementById("message-${id}"); return Boolean(pane && row && pane.contains(row)); })()`;
}

/**
 * Whether message `id` is laid out inside the conversation pane. A thread pane stays mounted but
 * hidden once the conversation shows, and a thread's root is a row of both.
 */
export function shownInPane(id: string) {
  return `(() => { const pane = ${pane}; return Boolean(pane) && [...pane.querySelectorAll('[id="message-${id}"]')].some((row) => row.getClientRects().length > 0); })()`;
}

/** Whether the pane lays out a conversation's Chat / Tasks / Files tabs (its header). */
export const paneTabsShown = `(() => { const pane = ${pane}; return Boolean(pane) && [...pane.querySelectorAll('[role="tablist"]')].some((tabs) => tabs.getClientRects().length > 0); })()`;

/** Resolves once `observe` holds, polling what the test cannot be told about (a database row). */
export async function waitFor(observe: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (!(await observe())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the database to change");
    await Bun.sleep(50);
  }
}

/** The text of the row marked as the one open in the pane, or null when none is. */
export const currentRow = `[...document.querySelectorAll(${rowItems})].find((item) => item.querySelector("a")?.getAttribute("aria-current") === "true")?.textContent ?? null`;

/** The open conversation as the Activity URL names it (`channel:<id>` or `dm:<id>`, prefixed
 * `thread:` for a thread shown alone). */
export const openParam = `new URLSearchParams(location.search).get("open")`;

/**
 * A channel shared by the viewer and the seeded peer, reset to this run's messages: the viewer's
 * thread root (`root`), which they follow, the peer's reply in it (`reply`), then a newer top-level
 * message from the peer (`newest`). The message `mention` names mentions the viewer. Every id comes
 * from `key`, so a rerun replaces the same rows.
 */
export async function seedChannel(
  db: PrismaClient,
  options: {
    workspaceId: string;
    key: string;
    channelName: string;
    root: string;
    reply: string;
    newest: { key: string; body: string };
    mention: "reply" | "newest";
  },
) {
  const { workspaceId, key } = options;
  const peer = await db.user.upsert({
    where: { id: seededUuid("e2e-activity-inbox:peer") },
    update: {},
    create: {
      id: seededUuid("e2e-activity-inbox:peer"),
      username: "e2e-activity-peer",
      displayName: "Activity Peer",
    },
  });
  await db.workspaceMembership.upsert({
    where: { workspaceId_userId: { workspaceId, userId: peer.id } },
    update: {},
    create: { workspaceId, userId: peer.id },
  });
  const channelId = seededUuid(`${key}channel`);
  await db.conversation.upsert({
    where: { id: channelId },
    update: { archivedAt: null },
    create: { id: channelId, workspaceId, channelName: options.channelName },
  });
  // Every run starts from the same state: no messages, follows or cursors from the last one.
  await db.message.deleteMany({ where: { conversationId: channelId } });
  const [viewer, other] = await Promise.all(
    [DEV_BROWSER_USER.id, peer.id].map((userId) =>
      db.conversationMember.upsert({
        where: { conversationId_userId: { conversationId: channelId, userId } },
        update: {
          leftAt: null,
          hiddenAt: null,
          readThroughSequence: 0,
          doneThroughSequence: null,
          unreadFromSequence: null,
        },
        create: { conversationId: channelId, workspaceId, userId },
      }),
    ),
  );
  const rootId = seededUuid(`${key}root`);
  const replyId = seededUuid(`${key}reply`);
  const newestId = seededUuid(`${key}${options.newest.key}`);
  const rows = [
    { id: rootId, body: options.root, senderMemberId: viewer!.id, threadRootId: null },
    { id: replyId, body: options.reply, senderMemberId: other!.id, threadRootId: rootId },
    { id: newestId, body: options.newest.body, senderMemberId: other!.id, threadRootId: null },
  ];
  let sequence = 1;
  for (const row of rows)
    await db.message.create({
      data: { ...row, conversationId: channelId, workspaceId, sequence: sequence++ },
    });
  await db.messageMention.create({
    data: {
      messageId: options.mention === "reply" ? replyId : newestId,
      memberId: viewer!.id,
      conversationId: channelId,
      workspaceId,
      kind: "user",
      actorId: DEV_BROWSER_USER.id,
      handle: DEV_BROWSER_USER.username,
    },
  });
  await db.threadFollow.create({
    data: { memberId: viewer!.id, rootMessageId: rootId, conversationId: channelId, workspaceId },
  });
  return { channelId, viewer: viewer!, rootId, replyId, newestId };
}

/**
 * A DM between the viewer and `otherUserId` (the viewer again for their DM with themself), its id
 * from `key` when new, and each member's row in it, with the Done cursors cleared.
 */
export async function seedDirectConversation(
  db: PrismaClient,
  workspaceId: string,
  key: string,
  otherUserId: string,
) {
  const directKey = peopleDirectKey(DEV_BROWSER_USER.id, otherUserId);
  const conversation = await db.conversation.upsert({
    where: { workspaceId_directKey: { workspaceId, directKey } },
    update: {},
    create: { id: seededUuid(key), workspaceId, directKey },
  });
  const members = await Promise.all(
    [...new Set([DEV_BROWSER_USER.id, otherUserId])].map((userId) =>
      db.conversationMember.upsert({
        where: { conversationId_userId: { conversationId: conversation.id, userId } },
        update: { leftAt: null, hiddenAt: null, doneThroughSequence: null },
        create: { conversationId: conversation.id, workspaceId, userId },
      }),
    ),
  );
  return { conversationId: conversation.id, members };
}
