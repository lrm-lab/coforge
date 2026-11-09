import { expect, test } from "bun:test";
import {
  agentSays,
  browser,
  evaluate,
  expectBadge,
  gatedProxy,
  holdDocument,
  newPeer,
  openPage,
  proxy,
  registerDmUnreadHooks,
  releaseHold,
  row,
  session,
  shot,
  state,
  useSession,
  waitForRow,
  wsInit,
  wsSession,
} from "./helpers/dm-agent-unread-harness";

/**
 * The realtime cases of the DM Agent unread browser E2E (the rest is in
 * `e2e-dm-agent-unread.e2e.ts`): replies sent while the page's realtime socket is down, and replies
 * that land before the page's subscription is up. They drive a second session whose sockets the
 * test can cut and block.
 *
 * Opt-in like the other browser E2Es: local built Web, PostgreSQL, Centrifugo, agent-browser.
 */
registerDmUnreadHooks();

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
  useSession(wsSession);
}

test("7. replies sent while the realtime socket is down badge the row after it reconnects on its own", async () => {
  const peer = await newPeer("reconnect");
  await startSocketSession();
  try {
    await openPage(`/channel/${state.otherChannelId}`, peer);
    await expectBadge(peer, 0);
    // Cut the socket and keep every new one from opening.
    await session().evaluate(
      `(window.__wsBlocked = true, window.__sockets.forEach((socket) => socket.close()), true)`,
    );
    await Bun.sleep(1_000);
    await agentSays(peer, "while down 1");
    await agentSays(peer, "while down 2");
    await Bun.sleep(2_000);
    // The drop took: the page has not heard the replies.
    expect((await row(peer))?.count).toBe(0);
    await shot("7-disconnected-0");
    await session().evaluate(`(window.__wsBlocked = false, true)`);
    await expectBadge(peer, 2, 60_000);
    await shot("7-reconnected-2");
  } finally {
    await session()
      .evaluate(`(window.__wsBlocked = false, true)`)
      .catch(() => undefined);
    useSession({ browser, evaluate });
  }
}, 240_000);

test("8. replies that land before the page's subscription is up still badge the row", async () => {
  // A: the replies are sent as soon as the page's load returns, with no settle.
  const early = await newPeer("early");
  await startSocketSession();
  try {
    await session().browser(
      "open",
      `${proxy.origin}/en/w/${state.workspaceSlug}/channel/${state.otherChannelId}`,
    );
    await agentSays(early, "right after open 1");
    await agentSays(early, "right after open 2");
    await waitForRow(early);
    await expectBadge(early, 2, 30_000);
    await shot("8a-replies-right-after-open");

    // B: the reply lands after the server rendered the page and before the client has loaded it,
    // so before any subscription: the document response is held while the Agent replies.
    const late = await newPeer("late");
    const pagePath = `/en/w/${state.workspaceSlug}/channel/${state.otherChannelId}`;
    const release = holdDocument(pagePath);
    const opening = session().browser("open", `${gatedProxy.origin}${pagePath}`);
    await Bun.sleep(3_000);
    await agentSays(late, "between render and subscribe");
    release();
    releaseHold();
    await opening;
    await waitForRow(late);
    await expectBadge(late, 1, 30_000);
    await shot("8b-reply-between-render-and-subscribe");
  } finally {
    releaseHold();
    useSession({ browser, evaluate });
  }
}, 240_000);
