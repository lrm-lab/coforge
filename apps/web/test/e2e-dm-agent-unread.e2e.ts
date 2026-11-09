import { expect, test } from "bun:test";
import {
  agentSays,
  browser,
  db,
  evaluate,
  expectBadge,
  expectNoBadgeSettled,
  newPeer,
  openPage,
  registerDmUnreadHooks,
  shot,
  state,
  viewerSays,
} from "./helpers/dm-agent-unread-harness";

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
registerDmUnreadHooks();

test("1. an Agent's top-level replies badge the DM row live while another conversation is open, then survive a reload", async () => {
  const peer = await newPeer("live");
  await browser("set", "viewport", "1440", "900");
  await openPage(`/channel/${state.otherChannelId}`, peer);
  await expectBadge(peer, 0);
  await agentSays(peer, "first reply");
  await expectBadge(peer, 1);
  await shot("1-live-1");
  for (const n of [2, 3, 4]) await agentSays(peer, `reply ${n}`);
  await expectBadge(peer, 4);
  await shot("1-live-4");
  // A reload reads the count from the server, and agrees.
  await openPage(`/channel/${state.otherChannelId}`, peer);
  await expectBadge(peer, 4);
  await shot("1-reloaded-4");
}, 180_000);

test("2. replies that arrive while the tab is in the background badge the row by the time it is back", async () => {
  const peer = await newPeer("background");
  await browser("set", "viewport", "1440", "900");
  await openPage(`/channel/${state.otherChannelId}`, peer);
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
  await openPage(`/channel/${state.otherChannelId}`, peer);
  await expectBadge(peer, 2);
  await shot("3-opened-with-2");
  await openPage(`/channel/${state.otherChannelId}`, peer);
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
  await openPage(`/channel/${state.otherChannelId}`, peer);
  await expectBadge(peer, 0);
  // In a DM the other side replying in a thread is talking to you, so the row counts it (Slack).
  await agentSays(peer, "Thread reply from the Agent", root.id);
  await expectBadge(peer, 1);
  await shot("5-thread-reply-badge");
  await openPage(`/channel/${state.otherChannelId}`, peer);
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
  // Reading the DM leaves the thread itself unread: Activity still lists its reply as new.
  await openPage("/activity", peer);
  const listed = `/Thread root from the viewer\\s+1 new/.test(document.querySelector("[data-activity-list]")?.innerText ?? "")`;
  await browser("wait", "--fn", listed, "--timeout", "15000");
  await shot("5-activity-after-open");
  // A thread reply while the DM is open is read there and then: no badge comes back on leaving.
  await openPage(`/dm/${peer.conversationId}`, peer);
  await agentSays(peer, "Thread reply while the DM is open", root.id);
  await Bun.sleep(1_500);
  await openPage(`/channel/${state.otherChannelId}`, peer);
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
  await browser(
    "eval",
    `document.querySelector('a[href*="/channel/${state.otherChannelId}"]').click()`,
  );
  await browser(
    "wait",
    "--fn",
    `location.pathname.includes("/channel/${state.otherChannelId}")`,
    "--timeout",
    "20000",
  );
  await expectBadge(peer, 0);
  await agentSays(peer, "reply after leaving");
  await expectBadge(peer, 1);
  await shot("6-after-leaving-badge");
}, 180_000);
