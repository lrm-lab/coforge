import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e } from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * Real conversation entry with trailing task-conversion notices and delayed Task badges.
 * Needs a local built Web with skip-auth, PostgreSQL, Redis, local Centrifugo and agent-browser with default notification permission. No model runs.
 * Each case creates and removes its own channel; the suite removes its own Workspace and writer.
 * Screenshots and measured scroll positions live in .amp/e2e/conversation-entry-position/.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin || !["localhost", "127.0.0.1"].includes(new URL(centrifugoOrigin).hostname))
  throw new Error("COFORGE_E2E_CENTRIFUGO_URL must target local Centrifugo");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const artifacts = join(import.meta.dir, "../../../.amp/e2e/conversation-entry-position");
const { browser, evaluate } = browserSession(browserPath, `entry-position-${process.pid}`);
let workspaceId: string;
let workspaceSlug: string;
let writerId: string;
const history = `document.querySelector('[aria-label="Message history" i]')`;
const position = `(() => { const h=${history}; return h && {distance:h.scrollHeight-h.scrollTop-h.clientHeight,top:h.scrollTop,height:h.scrollHeight,viewport:h.clientHeight,back:!!document.querySelector('button[aria-label="Back to bottom" i]')}; })()`;

beforeAll(async () => {
  await mkdir(artifacts, { recursive: true });
  await db.user.upsert({
    where: { id: DEV_BROWSER_USER.id },
    update: {},
    create: {
      id: DEV_BROWSER_USER.id,
      username: DEV_BROWSER_USER.username,
      displayName: "Entry reviewer",
      welcomedAt: new Date(),
    },
  });
  const writer = await db.user.create({
    data: { username: `entry-writer-${process.pid}`, displayName: "Entry writer" },
  });
  writerId = writer.id;
  const workspace = await db.workspace.create({
    data: {
      name: "Conversation entry",
      slug: `entry-position-${process.pid}`,
      members: { create: [{ userId: DEV_BROWSER_USER.id, role: "owner" }, { userId: writerId }] },
    },
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.slug;
});

afterAll(async () => {
  await browser("close");
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (writerId) await db.user.delete({ where: { id: writerId } });
  await db.$disconnect();
});

const modeTitles = {
  read: "all-read opens at bottom",
  unread: "unread opens on first unread",
  "system-unread": "unread starts inside the final system notices",
  reading: "scrolling up stays put",
  "thread-unread": "an unread last message with a thread preview stays at the bottom",
};

for (const width of [1440, 390]) {
  for (const mode of ["read", "unread", "system-unread", "reading", "thread-unread"] as const) {
    const unread = mode === "unread" || mode === "system-unread";
    const reading = mode === "reading";
    // Task #192: the oldest unread is the last message, a thread root whose preview (reply count
    // and reply rows) ends the stream. Opening on it lands at the bottom, and the Task rows that
    // fill in above it afterwards must not leave the preview's last row cut off.
    const thread = mode === "thread-unread";
    test(`${width}px ${modeTitles[mode]} after Task rows settle, including final system notices`, async () => {
      const name = `${width}-${mode}`;
      const channel = await db.conversation.create({ data: { workspaceId, channelName: name } });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let taskSeen!: () => void;
      const seen = new Promise<void>((resolve) => {
        taskSeen = resolve;
      });
      // Delay the actual public Task read, not a timer or a fabricated UI result. The DOM first
      // lays out the messages/notices, then the real response adds their Task badges.
      const proxy = sameOriginProxy(origin, centrifugoOrigin, {
        async afterUpstream(url) {
          const query = decodeURIComponent(url.search);
          if (
            url.pathname.includes("_serverFn") &&
            query.includes(channel.id) &&
            query.includes("sequenceFrom")
          ) {
            taskSeen();
            await gate;
          }
        },
      });
      try {
        const viewer = await db.conversationMember.create({
          data: {
            workspaceId,
            conversationId: channel.id,
            userId: DEV_BROWSER_USER.id,
            readThroughSequence: mode === "system-unread" ? 85 : unread ? 72 : 86,
            collapseLongMessages: false,
          },
        });
        const writer = await db.conversationMember.create({
          data: { workspaceId, conversationId: channel.id, userId: writerId },
        });
        await db.message.createMany({
          data: Array.from({ length: 80 }, (_, i) => ({
            workspaceId,
            conversationId: channel.id,
            senderMemberId: writer.id,
            sequence: i + 1,
            body: `Entry message ${i + 1}.\n\nA realistic conversation has earlier paragraphs, replies and task updates.`,
          })),
        });
        for (let n = 81; n <= 84; n++) {
          const message = await db.message.create({
            data: {
              workspaceId,
              conversationId: channel.id,
              senderMemberId: writer.id,
              sequence: n,
              body: `Task entry ${n}\n\n${"Review the conversation entry and preserve the reader's position.\n\n".repeat(4)}`,
            },
          });
          await db.task.create({
            data: {
              workspaceId,
              conversationId: channel.id,
              id: message.id,
              messageId: message.id,
              number: n - 80,
              title: `Task entry ${n}`,
              description: "Entry regression",
              status: "in_progress",
              creatorMemberId: viewer.id,
              ownerMemberId: writer.id,
            },
          });
        }
        await db.message.createMany({
          data: [85, 86].map((sequence) => ({
            workspaceId,
            conversationId: channel.id,
            sequence,
            body: `📋 Entry writer converted a message to task #${sequence - 82}`,
          })),
        });
        if (thread) {
          const root = await db.message.create({
            data: {
              workspaceId,
              conversationId: channel.id,
              senderMemberId: writer.id,
              sequence: 87,
              body: "Thread root: shall we ship the release notes tonight?",
            },
          });
          await db.message.createMany({
            data: [88, 89].map((sequence) => ({
              workspaceId,
              conversationId: channel.id,
              senderMemberId: writer.id,
              sequence,
              threadRootId: root.id,
              body: `Thread reply ${sequence - 87}: after the staging check.`,
            })),
          });
        }
        const firstNotice = await db.message.findFirstOrThrow({
          where: { conversationId: channel.id, sequence: 85 },
        });
        const boundary = await db.message.findFirstOrThrow({
          where: { conversationId: channel.id, sequence: mode === "system-unread" ? 86 : 73 },
        });
        await browser("set", "viewport", String(width), "900");
        // The thread preview's rows fill in after the pane has opened on it, as a preview that
        // arrives with the network read after the cached stream does. Chromium's scroll anchoring
        // then moves the position part of the way, and its scroll event reaches the pane before
        // the resize does (the order Frank's phone left the last reply row cut off in). Emulated in
        // one task, after the open's scrolls: grow the last preview (a style, not DOM React owns)
        // and move the position by part of the growth.
        const lateRows = join(artifacts, "late-thread-rows.js");
        if (thread)
          await Bun.write(
            lateRows,
            `const scrollTo = Element.prototype.scrollTo;
let armed = false;
Element.prototype.scrollTo = function (...args) {
  scrollTo.apply(this, args);
  if (armed || !this.matches('[aria-label="Message history" i]')) return;
  armed = true;
  setTimeout(() => {
    const preview = [...this.querySelectorAll("[data-thread-preview]")].at(-1);
    if (!preview) return;
    preview.style.paddingBottom = "136px";
    this.scrollTop += 60;
    window.__rowsFilledIn = true;
  }, 400);
};`,
          );
        await browser(
          "open",
          `${proxy.origin}/en/w/${workspaceSlug}/channel/${channel.id}`,
          ...(thread ? ["--init-script", lateRows] : []),
        );
        await browser(
          "wait",
          "--fn",
          `${history}?.querySelector('li[data-message-id="${firstNotice.id}"]') !== null`,
        );
        let gateTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            seen,
            new Promise<never>((_, reject) => {
              gateTimer = setTimeout(
                () => reject(new Error("The public Task read never reached the gate")),
                20_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(gateTimer);
        }
        if (reading) {
          await browser("wait", "--fn", `${position}?.distance <= 1`);
          // A reader scrolls with input, and the pane tells reading from its own scrolls by that
          // input (`ConversationBottomPin.read`). `agent-browser scroll` moves the position with no
          // input event, so when its scroll event coalesces with the Task rows' growth the pane
          // takes it for its own and re-pins to the bottom (task #198). A wheel, then its scroll:
          await browser(
            "eval",
            `(() => { const h=${history}; h.dispatchEvent(new WheelEvent("wheel", { deltaY: -24, bubbles: true })); h.scrollBy(0, -24); })()`,
          );
          await browser("wait", "--fn", `${position}?.distance >= 20`);
        }
        const anchor = reading
          ? await evaluate<{ id: string; offset: number }>(
              `(() => { const h=${history}; const top=h.getBoundingClientRect().top; const row=[...h.querySelectorAll('li[data-message-id]')].find(n=>n.getBoundingClientRect().bottom>top); return {id:row.dataset.messageId,offset:row.getBoundingClientRect().top-top}; })()`,
            )
          : undefined;
        await browser(
          "wait",
          "--fn",
          `document.body.textContent.toLowerCase().includes('get notified when your agents finish or need you')`,
        );
        // The opened thread root sits at the end: the banner shrinking the pane must not leave the
        // preview's last row cut off, even before the Task rows fill in. Read two frames on, once:
        // a read between a layout change and its resize callback sees a frame that never paints,
        // and a wait would pass a pane that recovers only by chance a second later.
        if (thread) {
          await browser("wait", "--fn", "window.__rowsFilledIn === true");
          await browser(
            "eval",
            `requestAnimationFrame(() => requestAnimationFrame(() => { window.__entryPosition = ${position}; }))`,
          );
          await browser("wait", "--fn", "window.__entryPosition !== undefined");
          const settled = await evaluate<{ distance: number; back: boolean }>(
            "window.__entryPosition",
          );
          expect(settled.distance).toBeLessThanOrEqual(1);
        }
        const before = await evaluate(position);
        release();
        await browser(
          "wait",
          "--fn",
          `${history}?.textContent.toLowerCase().includes('in progress')`,
        );
        if (!unread && !reading)
          await browser("wait", "--fn", `${position}?.distance <= 1 && !${position}?.back`);
        const after = await evaluate<{ distance: number; back: boolean; viewport: number }>(
          position,
        );
        await browser("screenshot", join(artifacts, `${name}.png`));
        await Bun.write(
          join(artifacts, `${name}.json`),
          JSON.stringify({ before, after }, null, 2),
        );
        if (unread) {
          const offset = await evaluate<number>(
            `(() => { const h=${history}; const row=h.querySelector('li[data-message-id="${boundary.id}"]'); return row.getBoundingClientRect().top-h.getBoundingClientRect().top; })()`,
          );
          expect(offset).toBeGreaterThanOrEqual(0);
          if (mode === "system-unread") expect(offset).toBeLessThan(after.viewport);
          else expect(offset).toBeLessThanOrEqual(16);
        } else if (anchor) {
          const offset = await evaluate<number>(
            `(() => { const h=${history}; return h.querySelector('li[data-message-id="${anchor.id}"]').getBoundingClientRect().top-h.getBoundingClientRect().top; })()`,
          );
          expect(Math.abs(offset - anchor.offset)).toBeLessThanOrEqual(1);
        } else {
          expect(after.distance).toBeLessThanOrEqual(1);
          expect(after.back).toBe(false);
          await browser(
            "eval",
            `window.__TSR_ROUTER__.navigate({to:"/w/$workspaceSlug/channel/$channelId",params:{workspaceSlug:${JSON.stringify(workspaceSlug)},channelId:${JSON.stringify(channel.id)}},search:{message:${JSON.stringify(boundary.id)}}})`,
          );
          await browser(
            "wait",
            "--fn",
            `(() => { const h=${history}; const row=h.querySelector('li[data-message-id="${boundary.id}"]'); const rect=row.getBoundingClientRect(); return rect.bottom>h.getBoundingClientRect().top && rect.top<h.getBoundingClientRect().bottom && !!document.querySelector('button[aria-label="Back to bottom" i]'); })()`,
          );
          const jumped = await evaluate<{ distance: number; back: boolean }>(position);
          await Bun.write(join(artifacts, `${name}-jump.json`), JSON.stringify(jumped, null, 2));
          expect(jumped.distance).toBeGreaterThan(48);
          expect(jumped.back).toBe(true);
        }
      } finally {
        release();
        proxy.stop();
        await db.conversation.delete({ where: { id: channel.id } });
      }
    }, 120_000);
  }
}
