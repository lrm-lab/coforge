import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { peopleDirectKey } from "#src/features/conversations/direct-key";
import { personAvatarUrl } from "#src/lib/person-picture";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  activeCount,
  browserSession,
  currentRow,
  hydrated,
  inPane,
  listColumnWidth,
  openParam,
  pane,
  paneTabsShown,
  pinnedItems,
  rowItems,
  seedChannel,
  seededUuid,
  shownInPane,
  waitFor,
} from "./helpers/activity-inbox-e2e";

/**
 * The Activity page in a real browser: listing, the "N active" count, the views, the row menu and
 * Done; on a wide screen, opening a row beside a narrowed list (kept through a change of view and a
 * reload) and at the right message, a thread's row showing only the thread and leaving its channel
 * unread until "View in channel" (a profile opened from it covering it and returning to it), and
 * the thread's close returning to the list; member DMs; and the Pinned section. The phone layout
 * is `e2e-activity-inbox-phone.e2e.ts`.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel, its peer and
 * its messages are seeded deterministically and reset on every run. Screenshots of the wide
 * layout, with and without a conversation open, and with a Pinned section (`pinned.png`), are
 * written under `.amp/e2e/activity-inbox/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/activity-inbox");

test("the Activity page lists, filters, marks Done and opens inbox items", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `activity-inbox-${process.pid}`;
  const { browser, evaluate } = browserSession(browserPath, session);
  /** The text of every row this test seeded (its channel's and its thread's), in page order. */
  const seededRows = `[...document.querySelectorAll(${rowItems})]
    .map((row) => row.textContent)
    .filter((text) => text.includes("e2e-activity-inbox"))`;
  try {
    const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
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
    // A second channel with a followed thread the viewer has read to the end, where nothing
    // mentions them. The channel itself is Done, so only the thread row lists.
    const quietChannelId = seededUuid("e2e-activity-inbox:quiet-channel");
    await db.conversation.upsert({
      where: { id: quietChannelId },
      update: { archivedAt: null },
      create: { id: quietChannelId, workspaceId, channelName: "e2e-activity-quiet" },
    });
    await db.message.deleteMany({ where: { conversationId: quietChannelId } });
    const quietViewer = await db.conversationMember.upsert({
      where: {
        conversationId_userId: { conversationId: quietChannelId, userId: DEV_BROWSER_USER.id },
      },
      update: {
        leftAt: null,
        readThroughSequence: 1,
        doneThroughSequence: 1,
        unreadFromSequence: null,
      },
      create: {
        conversationId: quietChannelId,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
        readThroughSequence: 1,
        doneThroughSequence: 1,
      },
    });
    const quietRootId = seededUuid("e2e-activity-inbox:quiet-root");
    const quietNewestId = seededUuid("e2e-activity-inbox:quiet-newest");
    // Enough replies that the thread pane scrolls: the newest one is out of view at the root.
    const quietRows = [
      { id: quietRootId, body: "E2E quiet root", threadRootId: null },
      ...Array.from({ length: 39 }, (_, index) => ({
        id: seededUuid(`e2e-activity-inbox:quiet-reply-${index}`),
        body: `E2E quiet reply ${index + 1}`,
        threadRootId: quietRootId,
      })),
      { id: quietNewestId, body: "E2E quiet newest reply", threadRootId: quietRootId },
    ];
    for (const [index, row] of quietRows.entries())
      await db.message.create({
        data: {
          ...row,
          senderMemberId: quietViewer.id,
          conversationId: quietChannelId,
          workspaceId,
          sequence: index + 1,
        },
      });
    await db.threadFollow.create({
      data: {
        memberId: quietViewer.id,
        rootMessageId: quietRootId,
        conversationId: quietChannelId,
        workspaceId,
      },
    });
    await db.threadRead.create({
      data: {
        memberId: quietViewer.id,
        rootMessageId: quietRootId,
        conversationId: quietChannelId,
        workspaceId,
        readThroughSequence: quietRows.length,
      },
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}${workspacePath}/activity`);
    await browser("wait", "--fn", `${seededRows}.length === 2 && ${hydrated}`);
    const rows = await evaluate<string[]>(seededRows);
    // Newest activity first: the channel's unread message was posted after the thread reply. A
    // channel's row goes by its bare name (the # is its icon); a thread's names its channel
    // before the latest reply.
    expect(rows[0]).toContain("e2e-activity-inbox");
    expect(rows[0]).not.toContain("#e2e-activity-inbox");
    expect(rows[0]).toContain("1 new");
    expect(rows[0]).toContain("Activity Peer: E2E activity unread");
    expect(rows[1]).toContain("E2E activity root");
    expect(rows[1]).toContain("@you");
    expect(rows[1]).toContain("1 new");
    expect(rows[1]).toContain("#e2e-activity-inbox · Activity Peer: ");
    // Nothing is open, so there is no conversation area: the list spans the page.
    expect(await evaluate<boolean>(`${pane} === null`)).toBe(true);
    const fullWidth = await evaluate<number>(listColumnWidth);
    expect(fullWidth / (await evaluate<number>("innerWidth"))).toBeGreaterThan(0.6);
    // The header counts every row the All view lists, these two among them.
    const active = await evaluate<number | null>(activeCount);
    expect(active).toBeGreaterThanOrEqual(2);
    // The preview renders Markdown inline: the mention as a chip, emphasis and code as markup.
    const preview = await evaluate<{ strong: string | null; code: string | null }>(`(() => {
      const row = [...document.querySelectorAll(${rowItems})].find((item) =>
        item.textContent.includes("E2E activity root"));
      return {
        strong: row.querySelector("strong")?.textContent ?? null,
        code: row.querySelector("code")?.textContent ?? null,
      };
    })()`);
    expect(preview).toEqual({ strong: "reply", code: "code" });
    // The Unread and Mentions tabs count rows: both seeded rows are unread, and the thread's
    // reply is an unread mention. Other rows of the dev user's inbox may add to both.
    // Activity's own tabs: an open conversation beside the list has tabs of its own.
    const tabCounts = `Object.fromEntries([...document.querySelectorAll('[role="tablist"][aria-label="Filter Activity"] [role="tab"]')].map((tab) => [tab.textContent.replace(/[\\d+]/g, "").trim(), Number(tab.textContent.replace(/\\D/g, "")) || 0]))`;
    const counts = await evaluate<Record<string, number>>(tabCounts);
    expect(Object.keys(counts)).toEqual(["All", "Unread", "Mentions"]);
    expect(counts.All).toBe(0);
    expect(counts.Unread).toBeGreaterThanOrEqual(2);
    expect(counts.Mentions).toBeGreaterThanOrEqual(1);
    await browser("screenshot", join(artifacts, "wide.png"));

    await browser("find", "role", "tab", "click", "--name", "Mentions");
    await browser("wait", "--fn", `location.search.includes("filter=mentions")`);
    await browser("wait", "--fn", `${seededRows}.length === 1`);
    expect((await evaluate<string[]>(seededRows))[0]).toContain("E2E activity root");
    // The counts do not depend on the tab showing.
    expect(await evaluate<Record<string, number>>(tabCounts)).toEqual(counts);
    await browser("find", "role", "tab", "click", "--name", "All");
    await browser("wait", "--fn", `${seededRows}.length === 2`);

    // The row menu opens on a right click (a long press on touch).
    await evaluate(`(() => {
      const row = [...document.querySelectorAll(${rowItems})].find((item) =>
        item.textContent.includes("E2E activity root"));
      const link = row.querySelector("a");
      const box = link.getBoundingClientRect();
      link.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: box.x + 20, clientY: box.y + 10,
      }));
      return true;
    })()`);
    await browser("wait", "--fn", `document.querySelectorAll('[role="menuitem"]').length > 0`);
    const menu = await evaluate<string[]>(
      `[...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent.trim())`,
    );
    expect(menu).toEqual(["Mark as Read", "Done", "Unfollow thread"]);
    await browser("screenshot", join(artifacts, "row-menu.png"));
    await browser("press", "Escape");

    // Read and unread from the row menu move the badge both ways.
    const channelMenu = (label: string) =>
      evaluate(`(() => {
        const row = [...document.querySelectorAll(${rowItems})].find((item) =>
          item.textContent.includes("E2E activity unread"));
        const link = row.querySelector("a");
        const box = link.getBoundingClientRect();
        link.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true, cancelable: true, clientX: box.x + 20, clientY: box.y + 10,
        }));
        return true;
      })()`)
        .then(() =>
          // This menu's own item: the previous menu may still be closing.
          browser(
            "wait",
            "--fn",
            `[...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent.trim() === ${JSON.stringify(label)})`,
          ),
        )
        .then(() =>
          evaluate(`[...document.querySelectorAll('[role="menuitem"]')]
            .find((item) => item.textContent.trim() === ${JSON.stringify(label)})
            .click() ?? true`),
        );
    // One line: a wait expression is passed to the browser CLI as a single argument.
    const channelRow = `[...document.querySelectorAll(${rowItems})].find((item) => item.textContent.includes("E2E activity unread")).textContent`;
    await channelMenu("Mark as Read");
    await browser("wait", "--fn", `!${channelRow}.includes("1 new")`);
    await browser("wait", "--fn", `${tabCounts}.Unread === ${counts.Unread - 1}`);
    await channelMenu("Mark as Unread");
    await browser("wait", "--fn", `${channelRow}.includes("1 new")`);
    await browser("wait", "--fn", `${tabCounts}.Unread === ${counts.Unread}`);
    expect(await evaluate<boolean>(`!document.querySelector('[role="alert"]')`)).toBe(true);

    await evaluate(`(() => {
      const row = [...document.querySelectorAll(${rowItems})].find((item) =>
        item.textContent.includes("E2E activity unread"));
      row.querySelector('[aria-label="Mark as Done"]').click();
      return true;
    })()`);
    await browser("wait", "--fn", `${seededRows}.length === 1`);
    // Done took an unread row away, and the Unread and active counts with it.
    await browser("wait", "--fn", `${tabCounts}.Unread === ${counts.Unread - 1}`);
    await browser("wait", "--fn", `${activeCount} === ${active! - 1}`);
    await browser("reload");
    await browser("wait", "--fn", `${seededRows}.length === 1 && ${hydrated}`);
    expect((await evaluate<string[]>(seededRows))[0]).toContain("E2E activity root");

    // Nothing is open until a row is clicked: opening one reads it.
    expect(await evaluate<string | null>(openParam)).toBeNull();
    expect(await evaluate<string | null>(currentRow)).toBeNull();
    // A thread opens alone and leaves its channel unread. The steps above read the channel (Mark
    // as Read, Done), so its cursor goes back to the start, and the thread's to never read; the
    // channel stays Done, so its row stays off the list.
    await db.conversationMember.update({
      where: { id: viewer.id },
      data: { readThroughSequence: 0, unreadFromSequence: null },
    });
    await db.threadRead.deleteMany({ where: { memberId: viewer.id, rootMessageId: rootId } });
    await browser("find", "text", "E2E activity root", "click");
    await browser("wait", "--fn", `location.search.includes("threadRootId=${rootId}")`);
    // The thread opens alone beside the list, which stays on Activity; its pane scrolls to the
    // first unread reply.
    await browser("wait", "--fn", inPane(replyId));
    expect(await evaluate<string>("location.pathname")).toBe(`${workspacePath}/activity`);
    expect(await evaluate<string | null>(openParam)).toBe(`thread:channel:${channelId}`);
    expect(await evaluate<string | null>(currentRow)).toContain("E2E activity root");
    // Only the thread: its root and reply, without the channel's header and tabs or its newer
    // top-level message.
    expect(await evaluate<boolean>(shownInPane(rootId))).toBe(true);
    expect(await evaluate<boolean>(shownInPane(newestId))).toBe(false);
    expect(await evaluate<boolean>(paneTabsShown)).toBe(false);
    // Opening a row narrows the list beside the conversation.
    expect(await evaluate<boolean>(`${pane} !== null`)).toBe(true);
    expect(await evaluate<number>(listColumnWidth)).toBeLessThan(fullWidth);
    await browser("screenshot", join(artifacts, "wide-open.png"));
    // The thread is read; the channel is not.
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
    // Switching the list's view keeps the conversation open. Clicked through Activity's own
    // tablist: the open conversation has tabs too.
    const filterTab = (name: string) =>
      evaluate(`[...document.querySelectorAll('[role="tablist"][aria-label="Filter Activity"] [role="tab"]')]
        .find((tab) => tab.textContent.replace(/[\\d+]/g, "").trim() === ${JSON.stringify(name)})
        .click() ?? true`);
    await filterTab("Mentions");
    await browser("wait", "--fn", `location.search.includes("filter=mentions")`);
    expect(await evaluate<string | null>(openParam)).toBe(`thread:channel:${channelId}`);
    expect(await evaluate<boolean>(inPane(replyId))).toBe(true);
    await filterTab("All");
    await browser("wait", "--fn", `!location.search.includes("filter=")`);
    expect(await evaluate<string | null>(openParam)).toBe(`thread:channel:${channelId}`);
    // The open thread lives in the URL: a reload reopens it alone beside the list.
    await browser("reload");
    await browser("wait", "--fn", `${inPane(replyId)} && ${hydrated}`);
    await browser("wait", "--fn", `(${currentRow})?.includes("E2E activity root") === true`);
    expect(await evaluate<string | null>(openParam)).toBe(`thread:channel:${channelId}`);
    expect(await evaluate<boolean>(shownInPane(newestId))).toBe(false);
    // Still unread after a change of view and a reload, each showing the thread alone again.
    expect(
      (await db.conversationMember.findUniqueOrThrow({ where: { id: viewer.id } }))
        .readThroughSequence,
    ).toBe(0);
    // A profile opened from the thread covers it, still without the conversation, and its close
    // returns to the thread.
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
    await browser(
      "click",
      'section[aria-label="Selected conversation"] aside [aria-label="Close"]',
    );
    await browser("wait", "--fn", `${shownInPane(rootId)} && !(${profilePanel})`);
    expect(await evaluate<boolean>(shownInPane(newestId))).toBe(false);
    // "View in channel" shows the channel in the pane in place of the thread, and reads it.
    await browser("click", '[aria-label="Thread actions"]');
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
    // The thread's close closes the pane, back to the list alone.
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

    // A thread read to the end with no mention opens at its newest reply. Activity without an
    // open conversation (where its nav item leads) is the full-width list again.
    await browser("open", `${origin}${workspacePath}/activity`);
    await browser(
      "wait",
      "--fn",
      `document.body.textContent.includes("E2E quiet root") && ${hydrated}`,
    );
    expect(await evaluate<boolean>(`${pane} === null`)).toBe(true);
    await browser("find", "text", "E2E quiet root", "click");
    await browser("wait", "--fn", `location.search.includes("threadRootId=${quietRootId}")`);
    // The newest reply sits inside the visible part of the scrolled thread pane.
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
    /** A DM between people and each member's row in it, with the viewer's Done cursor cleared. */
    async function directConversation(key: string, otherUserId: string) {
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
    const withPeer = await directConversation("e2e-activity-inbox:dm", peer.id);
    await db.message.deleteMany({ where: { conversationId: withPeer.conversationId } });
    await db.conversationMember.updateMany({
      where: { conversationId: withPeer.conversationId },
      data: { readThroughSequence: 0, unreadFromSequence: null },
    });
    const withSelf = await directConversation("e2e-activity-inbox:self-dm", DEV_BROWSER_USER.id);
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
      `${row("E2E activity DM hello")} !== null && ${row("E2E activity note to self")} !== null && ${hydrated}`,
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
    await browser("wait", "--fn", `${row("E2E activity DM hello")} !== null && ${hydrated}`);
    expect((await evaluate<{ text: string }>(row("E2E activity DM hello"))).text).not.toContain(
      "1 new",
    );
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 90_000);

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
      `${rowsIn(pinnedItems)}.length === 1 && ${rowsIn(rowItems)}.length === 1 && ${hydrated}`,
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
    await browser("wait", "--fn", `${rowsIn(pinnedItems)}.length === 1 && ${hydrated}`);
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
