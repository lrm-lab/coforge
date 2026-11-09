import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * "In the sidebar's Direct Messages list, when an Agent replies in a DM there often is no unread
 * badge." Each case replies as the Agent through the real send (`SendDirectMessage.executeFromAgent`,
 * the Agent API's own path, announcing on the real Centrifugo) and reads the DM row in a real page:
 * on another conversation, in a background tab, after a reload, at phone width, for a reply inside a
 * thread (the row counts it, task #734), and for the DM that is itself open (no badge) before the
 * viewer leaves it.
 *
 * Opt-in like the other browser E2Es: local built Web, PostgreSQL, Centrifugo, agent-browser. Own
 * Workspace, Agents and Computer, removed afterwards. Screenshots are written
 * under `.amp/e2e/dm-agent-unread/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin || !["localhost", "127.0.0.1"].includes(new URL(centrifugoOrigin).hostname))
  throw new Error("COFORGE_E2E_CENTRIFUGO_URL must target local Centrifugo");
const proxy = sameOriginProxy(origin, centrifugoOrigin);
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const artifacts = join(import.meta.dir, "../../../.amp/e2e/dm-agent-unread");
const { browser, evaluate } = browserSession(browserPath, `dm-agent-unread-${process.pid}`);
const dms = new PrismaDirectConversationRepository(db, { oneRequest: true });
const centrifugo = createCentrifugoServerApi();
const sender = new SendDirectMessage(
  dms,
  { execute: async (_scope: unknown, persist: () => unknown) => persist() } as never,
  centrifugo,
  new CentrifugoConversationRealtime(centrifugo),
);

let workspaceId = "";
let workspaceSlug = "";
let computerId = "";
let otherChannelId = "";
let counter = 0;
const wsInit = join(artifacts, "ws-control-init.js");
const wsSession = browserSession(browserPath, `dm-agent-unread-ws-${process.pid}`);
/** Holds the document response of one page while armed, so a reply can land between the server's
 * render and the client's subscribe. */
let hold: { path: string; released: Promise<void> } | null = null;
const gatedProxy = sameOriginProxy(origin, centrifugoOrigin, {
  async afterUpstream(url) {
    if (hold && url.pathname === hold.path) await hold.released;
  },
});

type Peer = { name: string; agentId: string; conversationId: string; memberId: string };

/** A fresh Agent with its DM with the viewer, so each case starts with nothing unread. */
async function newPeer(label: string): Promise<Peer> {
  counter += 1;
  const name = `Unread Agent ${label}`;
  const agent = await db.agent.create({
    data: {
      workspaceId,
      ownerId: DEV_BROWSER_USER.id,
      computerId,
      name: `unread-agent-${label}-${process.pid}`,
      displayName: name,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "e2e-model",
        modelProvider: "e2e-provider",
        reasoning: "balanced",
      },
    },
  });
  const conversation = await dms.getOrCreateUserAgent(workspaceId, DEV_BROWSER_USER.id, agent.id);
  const member = await db.conversationMember.findUniqueOrThrow({
    where: {
      conversationId_userId: { conversationId: conversation.id, userId: DEV_BROWSER_USER.id },
    },
  });
  return { name, agentId: agent.id, conversationId: conversation.id, memberId: member.id };
}

/** The Agent replies, top level or inside the thread of `threadRootId`, through the real send. */
function agentSays(peer: Peer, body: string, threadRootId?: string) {
  return sender.executeFromAgent({
    idempotencyKey: crypto.randomUUID(),
    workspaceId,
    agentId: peer.agentId,
    target: `@${DEV_BROWSER_USER.username}${threadRootId ? `:${threadRootId}` : ""}`,
    body,
  });
}

/** The viewer's own top-level message in the DM, as a root for a thread. */
async function viewerSays(peer: Peer, body: string) {
  const newest = await db.message.findFirst({
    where: { conversationId: peer.conversationId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId: peer.conversationId,
      senderMemberId: peer.memberId,
      sequence: (newest?.sequence ?? 0) + 1,
      body,
    },
  });
  await db.conversationMember.update({
    where: { id: peer.memberId },
    data: { readThroughSequence: message.sequence },
  });
  return message;
}

type Row = { count: number; badgeShown: boolean; label: string | null } | null;
/** The DM's sidebar row: the count its accessible name states, and whether a badge is laid out. */
const dmRow = (peer: Peer) => `(() => {
  const link = document.querySelector('a[href*="/dm/${peer.conversationId}"]');
  if (!link) return null;
  const badge = [...link.querySelectorAll('span[aria-hidden="true"]')].find(
    (span) => span.classList.contains("rounded-full") && span.classList.contains("tabular-nums"),
  );
  const label = link.getAttribute("aria-label");
  const match = /(\\d+) unread message/.exec(label ?? "");
  return {
    count: match ? Number(match[1]) : 0,
    badgeShown: Boolean(badge) && badge.getClientRects().length > 0,
    label,
  };
})()`;

/** The session the helpers read: the main one, or the socket-controlled one of cases 7 and 8. */
let current = { browser, evaluate };
async function row(peer: Peer) {
  return current.evaluate<Row>(dmRow(peer));
}

/** Polls the row until it shows `count` (0: no badge at all), or fails naming what it shows. */
async function expectBadge(peer: Peer, count: number, ms = 12_000) {
  const deadline = Date.now() + ms;
  let seen: Row = null;
  while (Date.now() < deadline) {
    seen = await row(peer);
    if (seen && seen.count === count && seen.badgeShown === count > 0) return;
    await Bun.sleep(150);
  }
  throw new Error(`expected the DM row to show ${count}, it shows ${JSON.stringify(seen)}`);
}

/** The row stays without a badge for a while: a missed badge cannot be told from a slow one. */
async function expectNoBadgeSettled(peer: Peer, ms = 4_000) {
  await Bun.sleep(ms);
  const seen = await row(peer);
  expect(seen).not.toBeNull();
  expect(seen!.count).toBe(0);
  expect(seen!.badgeShown).toBe(false);
}

/** Loads a page and waits for the DM's row in the sidebar; the realtime join gets `settle` ms. */
async function openPage(path: string, peer: Peer, settle = 3_000, base = proxy.origin) {
  await current.browser("open", `${base}/en/w/${workspaceSlug}${path}`);
  await waitForRow(peer);
  await Bun.sleep(settle);
}

async function waitForRow(peer: Peer) {
  const present = `${pageHydrated} && document.querySelector('a[href*="/dm/${peer.conversationId}"]') !== null`;
  const deadline = Date.now() + 40_000;
  while (!(await current.evaluate<boolean>(present).catch(() => false))) {
    if (Date.now() > deadline) {
      const page = await current.evaluate<unknown>(
        `({ path: location.pathname, hydrated: ${pageHydrated}, anchors: [...document.querySelectorAll("a")].map((a) => a.getAttribute("href")).slice(0, 40), text: document.body.innerText.slice(0, 500) })`,
      );
      throw new Error(`the DM row never appeared: ${JSON.stringify(page)}`);
    }
    await Bun.sleep(500);
  }
}

const shot = (name: string) => current.browser("screenshot", join(artifacts, `${name}.png`));

beforeAll(async () => {
  await mkdir(artifacts, { recursive: true });
  await db.user.upsert({
    where: { id: DEV_BROWSER_USER.id },
    update: {},
    create: {
      id: DEV_BROWSER_USER.id,
      username: DEV_BROWSER_USER.username,
      displayName: "Unread reviewer",
      welcomedAt: new Date(),
    },
  });
  const workspace = await db.workspace.create({
    data: {
      name: "DM Agent unread",
      slug: `dm-agent-unread-${process.pid}`,
      members: { create: [{ userId: DEV_BROWSER_USER.id, role: "owner" }] },
    },
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.slug;
  const computer = await db.computer.create({
    data: { ownerId: DEV_BROWSER_USER.id, machineId: `dm-agent-unread-${process.pid}` },
  });
  computerId = computer.id;
  const channel = await db.conversation.create({
    data: { workspaceId, channelName: "elsewhere", description: "" },
  });
  otherChannelId = channel.id;
  await db.conversationMember.create({
    data: { workspaceId, conversationId: channel.id, userId: DEV_BROWSER_USER.id },
  });
});

afterAll(async () => {
  await browser("close").catch(() => undefined);
  await wsSession.browser("close").catch(() => undefined);
  proxy.stop();
  gatedProxy.stop();
  await Bun.file(wsInit)
    .delete()
    .catch(() => undefined);
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  if (computerId) await db.computer.delete({ where: { id: computerId } }).catch(() => undefined);
  await db.$disconnect();
});

test("1. an Agent's top-level replies badge the DM row live while another conversation is open, then survive a reload", async () => {
  const peer = await newPeer("live");
  await browser("set", "viewport", "1440", "900");
  await openPage(`/channel/${otherChannelId}`, peer);
  await expectBadge(peer, 0);
  await agentSays(peer, "first reply");
  await expectBadge(peer, 1);
  await shot("1-live-1");
  for (const n of [2, 3, 4]) await agentSays(peer, `reply ${n}`);
  await expectBadge(peer, 4);
  await shot("1-live-4");
  // A reload reads the count from the server, and agrees.
  await openPage(`/channel/${otherChannelId}`, peer);
  await expectBadge(peer, 4);
  await shot("1-reloaded-4");
}, 180_000);

test("2. replies that arrive while the tab is in the background badge the row by the time it is back", async () => {
  const peer = await newPeer("background");
  await browser("set", "viewport", "1440", "900");
  await openPage(`/channel/${otherChannelId}`, peer);
  await evaluate(
    `(window.__visibility = [document.visibilityState], document.addEventListener("visibilitychange", () => window.__visibility.push(document.visibilityState)), true)`,
  );
  await browser("tab", "new", "--label", "away", "about:blank");
  await agentSays(peer, "while away 1");
  await Bun.sleep(1_500);
  await agentSays(peer, "while away 2");
  await Bun.sleep(1_500);
  await agentSays(peer, "while away 3");
  await Bun.sleep(3_000);
  await browser("tab", "t1");
  await expectBadge(peer, 3);
  const visibility = await evaluate<string[]>("window.__visibility");
  // The tab was really hidden meanwhile, not merely unfocused.
  expect(visibility).toContain("hidden");
  await shot("2-back-from-background");
  await browser("tab", "close", "away").catch(() => undefined);
}, 180_000);

test("3. replies written before the page opens are counted from the server", async () => {
  const peer = await newPeer("server");
  await agentSays(peer, "before 1");
  await agentSays(peer, "before 2");
  await browser("set", "viewport", "1440", "900");
  await openPage(`/channel/${otherChannelId}`, peer);
  await expectBadge(peer, 2);
  await shot("3-opened-with-2");
  await openPage(`/channel/${otherChannelId}`, peer);
  await expectBadge(peer, 2);
}, 120_000);

test("4. at phone width the DM list shows the badge, live and after a reload", async () => {
  const peer = await newPeer("phone");
  await browser("set", "viewport", "390", "844");
  await openPage("", peer);
  await expectBadge(peer, 0);
  await agentSays(peer, "phone 1");
  await expectBadge(peer, 1);
  await agentSays(peer, "phone 2");
  await expectBadge(peer, 2);
  await shot("4-phone-live-2");
  await openPage("", peer);
  await expectBadge(peer, 2);
  await shot("4-phone-reloaded-2");
  await browser("set", "viewport", "1440", "900");
}, 120_000);

test("5. an Agent's reply inside a thread badges the DM row; opening the DM reads it, a reload too", async () => {
  const peer = await newPeer("thread");
  const root = await viewerSays(peer, "Thread root from the viewer");
  await browser("set", "viewport", "1440", "900");
  await openPage(`/channel/${otherChannelId}`, peer);
  await expectBadge(peer, 0);
  // In a DM the other side replying in a thread is talking to you, so the row counts it (Slack).
  await agentSays(peer, "Thread reply from the Agent", root.id);
  await expectBadge(peer, 1);
  await shot("5-thread-reply-badge");
  await openPage(`/channel/${otherChannelId}`, peer);
  await expectBadge(peer, 1);
  // Opening the DM reads it on through the thread's reply, though the reply is the newest message.
  await openPage(`/dm/${peer.conversationId}`, peer);
  const newest = await db.message.findFirstOrThrow({
    where: { conversationId: peer.conversationId },
    orderBy: { sequence: "desc" },
  });
  expect(newest.threadRootId).toBe(root.id);
  const deadline = Date.now() + 10_000;
  let readThrough = 0;
  while (Date.now() < deadline && readThrough < newest.sequence) {
    ({ readThroughSequence: readThrough } = await db.conversationMember.findUniqueOrThrow({
      where: { id: peer.memberId },
    }));
    await Bun.sleep(200);
  }
  expect(readThrough).toBe(newest.sequence);
  // A thread reply while the DM is open is read there and then: no badge comes back on leaving.
  await agentSays(peer, "Thread reply while the DM is open", root.id);
  await Bun.sleep(1_500);
  await openPage(`/channel/${otherChannelId}`, peer);
  await expectNoBadgeSettled(peer);
  await shot("5-read-after-open");
}, 180_000);

test("6. no badge while the DM is open; once left, the next reply badges it", async () => {
  const peer = await newPeer("open");
  await browser("set", "viewport", "1440", "900");
  await openPage(`/dm/${peer.conversationId}`, peer);
  await agentSays(peer, "reply while open");
  await expectNoBadgeSettled(peer);
  await shot("6-open-dm-no-badge");
  // The open DM read the reply: its cursor reached it, so leaving shows nothing stale.
  const newest = await db.message.findFirstOrThrow({
    where: { conversationId: peer.conversationId },
    orderBy: { sequence: "desc" },
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const member = await db.conversationMember.findUniqueOrThrow({ where: { id: peer.memberId } });
    if (member.readThroughSequence >= newest.sequence) break;
    await Bun.sleep(200);
  }
  await browser("eval", `document.querySelector('a[href*="/channel/${otherChannelId}"]').click()`);
  await browser(
    "wait",
    "--fn",
    `location.pathname.includes("/channel/${otherChannelId}")`,
    "--timeout",
    "20000",
  );
  await expectBadge(peer, 0);
  await agentSays(peer, "reply after leaving");
  await expectBadge(peer, 1);
  await shot("6-after-leaving-badge");
}, 180_000);

/** Init script of the second session: `__wsBlocked` makes the page's realtime sockets fail to open
 * (and `__sockets` lets the test close the open ones). */
const WS_CONTROL_INIT = `(() => {
  const Real = window.WebSocket;
  window.__sockets = [];
  window.__wsBlocked = false;
  function Wrapped(url, protocols) {
    const blocked = window.__wsBlocked && String(url).includes("/connection/");
    const socket = new Real(blocked ? "ws://127.0.0.1:1/blocked" : url, protocols);
    window.__sockets.push(socket);
    return socket;
  }
  Wrapped.prototype = Real.prototype;
  for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Wrapped[key] = Real[key];
  window.WebSocket = Wrapped;
})();`;

async function startSocketSession() {
  await Bun.write(wsInit, WS_CONTROL_INIT);
  // The init script is read when the session's browser launches, so it goes with the first command.
  await wsSession.browser("--init-script", wsInit, "set", "viewport", "1440", "900");
  current = wsSession;
}

test("7. replies sent while the realtime socket is down badge the row after it reconnects on its own", async () => {
  const peer = await newPeer("reconnect");
  await startSocketSession();
  try {
    await openPage(`/channel/${otherChannelId}`, peer);
    await expectBadge(peer, 0);
    // Cut the socket and keep every new one from opening.
    await current.evaluate(
      `(window.__wsBlocked = true, window.__sockets.forEach((socket) => socket.close()), true)`,
    );
    await Bun.sleep(1_000);
    await agentSays(peer, "while down 1");
    await agentSays(peer, "while down 2");
    await Bun.sleep(2_000);
    // The drop took: the page has not heard the replies.
    expect((await row(peer))?.count).toBe(0);
    await shot("7-disconnected-0");
    await current.evaluate(`(window.__wsBlocked = false, true)`);
    await expectBadge(peer, 2, 60_000);
    await shot("7-reconnected-2");
  } finally {
    await current.evaluate(`(window.__wsBlocked = false, true)`).catch(() => undefined);
    current = { browser, evaluate };
  }
}, 240_000);

test("8. replies that land before the page's subscription is up still badge the row", async () => {
  // A: the replies are sent as soon as the page's load returns, with no settle.
  const early = await newPeer("early");
  await startSocketSession();
  try {
    await current.browser(
      "open",
      `${proxy.origin}/en/w/${workspaceSlug}/channel/${otherChannelId}`,
    );
    await agentSays(early, "right after open 1");
    await agentSays(early, "right after open 2");
    await waitForRow(early);
    await expectBadge(early, 2, 30_000);
    await shot("8a-replies-right-after-open");

    // B: the reply lands after the server rendered the page and before the client has loaded it,
    // so before any subscription: the document response is held while the Agent replies.
    const late = await newPeer("late");
    const pagePath = `/en/w/${workspaceSlug}/channel/${otherChannelId}`;
    let release!: () => void;
    hold = { path: pagePath, released: new Promise<void>((resolve) => (release = resolve)) };
    const opening = current.browser("open", `${gatedProxy.origin}${pagePath}`);
    await Bun.sleep(3_000);
    await agentSays(late, "between render and subscribe");
    release();
    hold = null;
    await opening;
    await waitForRow(late);
    await expectBadge(late, 1, 30_000);
    await shot("8b-reply-between-render-and-subscribe");
  } finally {
    hold = null;
    current = { browser, evaluate };
  }
}, 240_000);
