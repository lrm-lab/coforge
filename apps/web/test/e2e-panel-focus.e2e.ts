import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  browserSession,
  hydratedElement,
  localBrowserE2e,
  pageHydrated,
  seededUuid,
} from "./helpers/browser-e2e";

/**
 * A panel of the Chat page fills the content card (task #75): the chat's and the thread's header
 * each have a full screen button, from `lg`. In full screen `main` carries `data-focus`, and the
 * conversation list and the other panel are not laid out. Esc leaves it. A thread's full screen
 * keeps the chat's scroll position and the thread's draft for the return. Closing the thread,
 * moving to another conversation or a window narrower than `lg` end it. A laptop (under `xl`)
 * gives the thread the room of the conversation list, which returns with the thread closed; a
 * phone has no full screen button at all.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`) + `agent-browser`.
 * It seeds a Workspace with two channels (one with a long history and a thread) and removes it
 * afterwards. Screenshots are written under `.amp/e2e/panel-focus/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/panel-focus");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const { browser, evaluate, waitFor } = browserSession(browserPath, `panel-focus-${process.pid}`);

const THREAD_ROOT = seededUuid(`e2e-panel-focus-${process.pid}:root`);
let workspaceId: string;
let workspaceSlug: string;
let chatId: string;
let otherId: string;

/** Whether the node `expression` resolves to is laid out (a hidden panel has no boxes). */
const shown = (expression: string) =>
  `((node) => Boolean(node) && node.getClientRects().length > 0)(${expression})`;
const LIST = `document.querySelector("main > section")`;
const THREAD = `document.querySelector('section[aria-label="Thread"]:not([hidden])')`;
const CHAT = `document.querySelector('[aria-label="Message history"]')`;
const COMPOSER = `${THREAD}?.querySelector("textarea")`;
const FOCUS = `(document.querySelector("main[data-focus]")?.getAttribute("data-focus") ?? null)`;
const LABELS = `button[aria-label="Full screen"], button[aria-label="Exit full screen"]`;
/** The chat header's full screen toggle: the one laid out outside the thread pane. */
const CHAT_TOGGLE = `[...document.querySelectorAll('${LABELS}')].find((button) => !button.closest('section[aria-label="Thread"]') && button.getClientRects().length > 0)`;
/** The thread header's full screen toggle. */
const THREAD_TOGGLE = `[...(${THREAD})?.querySelectorAll('${LABELS}') ?? []].find((button) => button.getClientRects().length > 0)`;
const CLOSE_THREAD = `${THREAD}?.querySelector('button[aria-label="Close thread"]')`;

const channelUrl = (id: string, thread = false) =>
  `${origin}/en/w/${workspaceSlug}/channel/${id}${thread ? `?threadRootId=${THREAD_ROOT}` : ""}`;

/** Opens the channel (with its thread) at `width` and waits until the page can be clicked. */
async function open(options: { width?: number; thread?: boolean; id?: string } = {}) {
  const { width = 1280, thread = true, id = chatId } = options;
  await browser("set", "viewport", String(width), "800");
  await browser("open", channelUrl(id, thread));
  // Under md the thread covers the chat, so it is the thread's back arrow that says it is up.
  const covered = thread && width < 768;
  await waitFor(
    covered
      ? `${pageHydrated} && document.querySelector('[aria-label="Back to chat"]') !== null`
      : `${pageHydrated} && ${shown(CHAT)} && ${CHAT}.scrollHeight > ${CHAT}.clientHeight${
          thread ? ` && ${shown(THREAD)} && ${shown(COMPOSER)}` : ""
        }`,
  );
}
/** Clicks the toggle `expression` finds, once React has attached its handler. */
async function press(toggle: string) {
  await waitFor(`${hydratedElement(`(${toggle})`)}`);
  await browser("eval", `(${toggle}).click()`);
}
const expectLabel = async (toggle: string, label: string) =>
  expect(await evaluate<string | null>(`(${toggle})?.getAttribute("aria-label") ?? null`)).toBe(
    label,
  );
/** Full screen is over: no `data-focus`, the list, the chat and the thread are all laid out. */
const waitForSplit = () =>
  waitFor(
    `${FOCUS} === null && ${shown(LIST)} && ${shown(CHAT)} && ${shown(THREAD)} && ${shown(CHAT_TOGGLE)}`,
  );

beforeAll(async () => {
  await mkdir(artifacts, { recursive: true });
  // A run that died before its cleanup leaves its Workspace behind.
  await db.workspace.deleteMany({ where: { slug: { startsWith: "panel-focus-" } } });
  await db.user.upsert({
    where: { id: DEV_BROWSER_USER.id },
    update: {},
    create: {
      id: DEV_BROWSER_USER.id,
      username: DEV_BROWSER_USER.username,
      displayName: "Focus reviewer",
      welcomedAt: new Date(),
    },
  });
  const workspace = await db.workspace.create({
    data: {
      name: "Panel focus",
      slug: `panel-focus-${process.pid}`,
      members: { create: { userId: DEV_BROWSER_USER.id, role: "owner" } },
    },
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.slug;
  /** A channel the viewer has read to the end, with `count` messages of their own. */
  async function seed(name: string, count: number, lastSequence: number) {
    const channel = await db.conversation.create({
      data: { workspaceId, channelName: name, lastSequence },
    });
    const viewer = await db.conversationMember.create({
      data: {
        conversationId: channel.id,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
        readThroughSequence: count,
      },
    });
    return { channel, viewer };
  }
  // A history long enough to scroll, ending in a thread's root, then the thread's replies.
  const history = 80;
  const { channel, viewer } = await seed("focus-chat", history, history + 2);
  chatId = channel.id;
  await db.message.createMany({
    data: Array.from({ length: history }, (_, index) => ({
      id:
        index === history - 1
          ? THREAD_ROOT
          : seededUuid(`e2e-panel-focus-${process.pid}:message-${index}`),
      body: index === history - 1 ? "Focus thread root" : `Focus chat message ${index + 1}`,
      senderMemberId: viewer.id,
      conversationId: channel.id,
      workspaceId,
      sequence: index + 1,
    })),
  });
  await db.message.createMany({
    data: [1, 2].map((reply) => ({
      id: seededUuid(`e2e-panel-focus-${process.pid}:reply-${reply}`),
      body: `Focus thread reply ${reply}`,
      senderMemberId: viewer.id,
      threadRootId: THREAD_ROOT,
      conversationId: channel.id,
      workspaceId,
      sequence: history + reply,
    })),
  });
  const other = await seed("focus-other", 3, 3);
  otherId = other.channel.id;
  await db.message.createMany({
    data: [1, 2, 3].map((index) => ({
      id: seededUuid(`e2e-panel-focus-${process.pid}:other-${index}`),
      body: `Focus other message ${index}`,
      senderMemberId: other.viewer.id,
      conversationId: other.channel.id,
      workspaceId,
      sequence: index,
    })),
  });
}, 120_000);

afterAll(async () => {
  await browser("close").catch(() => undefined);
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.$disconnect();
}, 60_000);

test("the chat's full screen hides the list and the thread, and Esc leaves it", async () => {
  await open();
  // A desktop shows the list, the chat and the thread side by side.
  expect(await evaluate<boolean>(`${shown(LIST)} && ${shown(CHAT)} && ${shown(THREAD)}`)).toBe(
    true,
  );
  expect(await evaluate<string | null>(FOCUS)).toBeNull();
  await expectLabel(CHAT_TOGGLE, "Full screen");

  await press(CHAT_TOGGLE);
  await waitFor(`${FOCUS} === "chat"`);
  await waitFor(`!${shown(LIST)} && !${shown(THREAD)} && ${shown(CHAT)}`);
  await expectLabel(CHAT_TOGGLE, "Exit full screen");
  await browser("screenshot", join(artifacts, "chat-focus.png"));

  await browser("press", "Escape");
  await waitForSplit();
  await expectLabel(CHAT_TOGGLE, "Full screen");

  // The same toggle, pressed again from full screen, leaves it too.
  await press(CHAT_TOGGLE);
  await waitFor(`${FOCUS} === "chat"`);
  await press(CHAT_TOGGLE);
  await waitForSplit();
}, 120_000);

test("the thread's full screen hides the chat and keeps the chat's scroll and the thread's draft", async () => {
  await open();
  const draft = "A reply I have not sent yet";
  // Scroll the chat up from the bottom, and write in the thread's composer.
  // Set directly, after a wheel event marks it as the reader's own scroll (the chat stops
  // following the latest). Late layout may nudge it, so whatever offset it settles at, above the
  // bottom, is the one the full screen must keep.
  await browser(
    "eval",
    `(() => { const chat = ${CHAT}; chat.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true })); chat.scrollTop = 500; return true; })()`,
  );
  await waitFor(
    `(() => { const chat = ${CHAT}; const now = chat.scrollTop; const settled = now === window.__chatTop && now < chat.scrollHeight - chat.clientHeight - 100; window.__chatTop = now; return settled; })()`,
  );
  const before = await evaluate<number>(`${CHAT}.scrollTop`);
  expect(before).toBeLessThan(
    await evaluate<number>(`${CHAT}.scrollHeight - ${CHAT}.clientHeight - 100`),
  );
  await browser("click", 'section[aria-label="Thread"]:not([hidden]) textarea');
  await browser("keyboard", "type", draft);
  await waitFor(`${COMPOSER}.value === ${JSON.stringify(draft)}`);

  await press(THREAD_TOGGLE);
  await waitFor(`${FOCUS} === "thread"`);
  await waitFor(`!${shown(LIST)} && !${shown(CHAT)} && ${shown(THREAD)}`);
  await expectLabel(THREAD_TOGGLE, "Exit full screen");
  expect(await evaluate<string>(`${COMPOSER}.value`)).toBe(draft);
  await browser("screenshot", join(artifacts, "thread-focus.png"));

  await press(THREAD_TOGGLE);
  await waitForSplit();
  expect(await evaluate<string>(`${COMPOSER}.value`)).toBe(draft);
  await waitFor(`Math.abs(${CHAT}.scrollTop - ${before}) <= 2`);

  // Esc leaves the thread's full screen the same way, with the draft still there.
  await press(THREAD_TOGGLE);
  await waitFor(`${FOCUS} === "thread"`);
  await browser("press", "Escape");
  await waitForSplit();
  expect(await evaluate<string>(`${COMPOSER}.value`)).toBe(draft);
  expect(Math.abs((await evaluate<number>(`${CHAT}.scrollTop`)) - before)).toBeLessThanOrEqual(2);
}, 120_000);

test("closing the thread while it is full screen leaves full screen", async () => {
  await open();
  await press(THREAD_TOGGLE);
  await waitFor(`${FOCUS} === "thread"`);
  await press(CLOSE_THREAD);
  await waitFor(
    `${FOCUS} === null && !location.search.includes("threadRootId") && !${shown(THREAD)} && ${shown(LIST)} && ${shown(CHAT)}`,
  );
}, 120_000);

test("moving to another conversation leaves full screen", async () => {
  // The list is how a conversation is chosen, so it is shown first: open the chat, choose the
  // other channel from the list, put it in full screen, and go back to the first one.
  await open({ thread: false });
  await waitFor(
    `${hydratedElement(`document.querySelector('main > section a[href$="/channel/${otherId}"]')`)}`,
  );
  await browser(
    "eval",
    `document.querySelector('main > section a[href$="/channel/${otherId}"]').click()`,
  );
  await waitFor(`location.pathname.endsWith("/channel/${otherId}") && ${shown(CHAT_TOGGLE)}`);
  await press(CHAT_TOGGLE);
  await waitFor(`${FOCUS} === "chat" && !${shown(LIST)}`);

  await browser("eval", `history.back()`);
  await waitFor(
    `location.pathname.endsWith("/channel/${chatId}") && ${FOCUS} === null && ${shown(LIST)} && ${shown(CHAT)}`,
  );
  await expectLabel(CHAT_TOGGLE, "Full screen");
}, 120_000);

test("a window narrower than lg leaves full screen, and widening it does not bring it back", async () => {
  await open();
  await press(CHAT_TOGGLE);
  await waitFor(`${FOCUS} === "chat"`);

  await browser("set", "viewport", "1000", "800");
  await waitFor(`${FOCUS} === null && ${shown(CHAT)} && !${shown(CHAT_TOGGLE)}`);

  await browser("set", "viewport", "1280", "800");
  await waitForSplit();
  expect(await evaluate<string | null>(FOCUS)).toBeNull();
  await expectLabel(CHAT_TOGGLE, "Full screen");
}, 120_000);

test("at lg with a thread open the list gives way to it, and returns when the thread closes", async () => {
  // Above xl the list stands beside the chat and the thread.
  await open({ width: 1280 });
  expect(await evaluate<boolean>(shown(LIST))).toBe(true);

  await open({ width: 1024 });
  await waitFor(`!${shown(LIST)} && ${shown(THREAD)} && ${shown(CHAT)}`);
  await press(CLOSE_THREAD);
  await waitFor(`!${shown(THREAD)} && ${shown(LIST)} && ${shown(CHAT)}`);
  await browser("screenshot", join(artifacts, "lg-thread-closed.png"));
}, 120_000);

test("a phone has no full screen button", async () => {
  const toggles = `[...document.querySelectorAll('${LABELS}')].filter((button) => button.getClientRects().length > 0).length`;
  await open({ width: 390, thread: false });
  expect(await evaluate<number>(toggles)).toBe(0);

  await open({ width: 390 });
  expect(await evaluate<number>(toggles)).toBe(0);
  // Both are in the page for a wider window: hidden by width, not absent from the markup.
  expect(await evaluate<number>(`document.querySelectorAll('${LABELS}').length`)).toBeGreaterThan(
    0,
  );
}, 120_000);
