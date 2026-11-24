import { afterAll, beforeAll, expect, test } from "bun:test";
import { State, SubscriptionState } from "centrifuge";

import {
  answerSubscriptionProxy,
  SUBSCRIPTION_LIFETIME_S,
  type BrowserSubscriptionAccess,
} from "#src/server/centrifugo/subscribe-proxy.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { chatStreamPositions } from "#src/server/conversations/chat-stream-positions.server";
import { streamMovedSince, type StreamPosition } from "#src/features/realtime/subscription-gap";
import {
  SUBSCRIBE_PROXY_API_KEY,
  settled,
  startSubscribeProxyHarness,
  until,
  watched,
  type SubscribeProxyHarness,
} from "./helpers/subscribe-proxy-harness";

// A page subscribes without a token and Centrifugo asks the Web, through the subscribe and
// sub-refresh proxies exactly as `infra/centrifugo/config.yaml` declares them: a refusal is final,
// a Web that cannot answer is retried until it can, a grant that is lost ends at its refresh, and
// a daemon's connection is refused. A page connects with the Web's own connection token, whose
// meta Centrifugo must hand the proxy. It also checks the stream positions a page compares to
// tell whether a subscribe missed anything (task #348). Docker required: `mise run test:centrifugo`.

const API_KEY = SUBSCRIBE_PROXY_API_KEY;
const ADA = "33333333-3333-4333-8333-333333333333";
const GRACE = "44444444-4444-4444-8444-444444444444";
const CONVERSATION = "55555555-5555-4555-8555-555555555555";
const WORKSPACE = "66666666-6666-4666-8666-666666666666";
const AGENT = "77777777-7777-4777-8777-777777777777";

/** Who reads `CONVERSATION`; the conversation check throws while the Web is `down`. */
const readers = new Set([ADA]);
let down = false;
/** `AGENT`'s visibility; Grace made it, and Ada's role in `WORKSPACE`. */
let agentVisibility = "public";
let adaRole: "admin" | "member" = "member";
/** How much sooner than `SUBSCRIPTION_LIFETIME_S` a grant runs out. */
let shortenBy = 0;
/** How many times Centrifugo asked the sub-refresh proxy. */
let refreshes = 0;
const access: BrowserSubscriptionAccess = {
  workspaceRole: async (workspaceId, userId) =>
    workspaceId === WORKSPACE && userId === ADA ? adaRole : undefined,
  workspaceAgent: async (workspaceId, agentId) =>
    workspaceId === WORKSPACE && agentId === AGENT
      ? { visibility: agentVisibility, ownerId: GRACE, systemKind: null }
      : undefined,
  readsArtifact: async () => false,
  readsConversation: async (conversationId, userId) => {
    if (down) throw new Error("database unavailable");
    return conversationId === CONVERSATION && readers.has(userId);
  },
};

let harness: SubscribeProxyHarness;
let centrifugoPort: number;
const connected = (user: string, daemon = false) => harness.connected(user, daemon);

beforeAll(async () => {
  harness = await startSubscribeProxyHarness((request, refresh) => {
    if (refresh) refreshes++;
    return answerSubscriptionProxy(request, access, {
      refresh,
      now: () => Date.now() - shortenBy * 1000,
    });
  });
  centrifugoPort = harness.centrifugoPort;
}, 60_000);

afterAll(async () => {
  await harness?.stop();
});

test("a reader is granted; anyone else is refused once and not retried", async () => {
  const ada = await connected(ADA);
  const grace = await connected(GRACE);
  const granted = watched(ada, `chat:${CONVERSATION}`);
  const refused = watched(grace, `chat:${CONVERSATION}`);
  await until(settled(granted.subscription), 5_000);
  await until(settled(refused.subscription), 5_000);
  // A retry would show as a second `subscribing`.
  await Bun.sleep(1_000);
  expect(granted.states).toEqual(["subscribing 0", "subscribed"]);
  expect(refused.states).toEqual(["subscribing 0", "unsubscribed 403"]);
  expect(grace.state).toBe(State.Connected);
}, 20_000);

test("while the Web cannot answer the page keeps retrying, and is subscribed once it can", async () => {
  const ada = await connected(ADA);
  down = true;
  try {
    const page = watched(ada, `chat:${CONVERSATION}`);
    // Centrifugo answers a non-200 from the proxy with its temporary internal error (100).
    await until(() => page.states.filter((state) => state === "error 100").length >= 3, 10_000);
    expect(page.subscription.state).toBe(SubscriptionState.Subscribing);
    down = false;
    await until(() => page.subscription.state === SubscriptionState.Subscribed, 5_000);
    expect(page.states).not.toContain("unsubscribed 403");
  } finally {
    down = false;
  }
}, 20_000);

test("a daemon's connection is refused even for its own user's channel", async () => {
  const daemon = await connected(ADA, true);
  const own = watched(daemon, `chat:user:${ADA}`);
  await until(settled(own.subscription), 5_000);
  expect(own.states).toEqual(["subscribing 0", "unsubscribed 403"]);
}, 20_000);

test("a grant still held is renewed by the refresh, which sees the page's connection", async () => {
  const ada = await connected(ADA);
  // Grants run out two seconds after they are given; Centrifugo checks expiries about once a
  // minute.
  shortenBy = SUBSCRIPTION_LIFETIME_S - 2;
  try {
    const page = watched(ada, `chat:${CONVERSATION}`);
    await until(() => page.subscription.state === SubscriptionState.Subscribed, 5_000);
    const before = refreshes;
    await until(() => refreshes > before, 90_000);
    // A refresh that did not see the page's meta would expire it (2501) and subscribe it again.
    await Bun.sleep(1_000);
    expect(page.states).toEqual(["subscribing 0", "subscribed"]);
  } finally {
    shortenBy = 0;
  }
}, 120_000);

test("a grant that is lost ends when it is next refreshed", async () => {
  const ada = await connected(ADA);
  // Grants run out two seconds after they are given; Centrifugo checks expiries about once a
  // minute.
  shortenBy = SUBSCRIPTION_LIFETIME_S - 2;
  try {
    const page = watched(ada, `chat:${CONVERSATION}`);
    await until(() => page.subscription.state === SubscriptionState.Subscribed, 5_000);
    readers.delete(ADA);
    await until(() => page.subscription.state === SubscriptionState.Unsubscribed, 90_000);
    await Bun.sleep(2_000);
    // Expired (2501), it subscribed again and met the refusal, final; the connection stays.
    expect(page.states).toEqual([
      "subscribing 0",
      "subscribed",
      "subscribing 2501",
      "unsubscribed 403",
    ]);
    expect(ada.state).toBe(State.Connected);
  } finally {
    shortenBy = 0;
    readers.add(ADA);
  }
}, 120_000);

test("a public Agent's own status channel is refused; the workspace channel carries it", async () => {
  // Task #377: a public Agent's status is published on the Workspace status channel. Its
  // per-Agent channel exists only for a private Agent, so a page may not subscribe to it.
  const ada = await connected(ADA);
  try {
    const page = watched(ada, `agentstatus:${WORKSPACE}:${AGENT}`);
    await until(() => page.subscription.state === SubscriptionState.Unsubscribed, 5_000);
    expect(page.states).toEqual(["subscribing 0", "unsubscribed 403"]);
    const workspacePage = watched(ada, `agentstatus:${WORKSPACE}`);
    await until(() => workspacePage.subscription.state === SubscriptionState.Subscribed, 5_000);
    expect(ada.state).toBe(State.Connected);
  } finally {
    agentVisibility = "public";
  }
}, 30_000);

test("a private Agent's status channel ends at the next refresh when the viewer loses the role", async () => {
  // Task #348: a page holds the channel through the subscribe proxy; a lost grant ends at its
  // refresh and is not retried. A private Agent's channel is visible to an admin, not a member.
  const ada = await connected(ADA);
  agentVisibility = "private";
  adaRole = "admin";
  shortenBy = SUBSCRIPTION_LIFETIME_S - 2;
  try {
    const page = watched(ada, `agentstatus:${WORKSPACE}:${AGENT}`);
    await until(() => page.subscription.state === SubscriptionState.Subscribed, 5_000);
    adaRole = "member";
    await until(() => page.subscription.state === SubscriptionState.Unsubscribed, 90_000);
    await Bun.sleep(2_000);
    expect(page.states).toEqual([
      "subscribing 0",
      "subscribed",
      "subscribing 2501",
      "unsubscribed 403",
    ]);
    expect(ada.state).toBe(State.Connected);
  } finally {
    shortenBy = 0;
    agentVisibility = "public";
    adaRole = "member";
  }
}, 120_000);

/**
 * Task #348: a page reads its Activity dot with where the viewer's own channel stood, then
 * subscribes. A mention published in between must show as missed, and nothing published must
 * show as nothing missed, with the positions the server API and the subscribe actually report.
 */
test("a mention published between a read and the subscribe shows as missed, and only then", async () => {
  const api = createCentrifugoServerApi({
    COFORGE_CENTRIFUGO_API_URL: `http://127.0.0.1:${centrifugoPort}/api`,
    COFORGE_CENTRIFUGO_API_KEY: API_KEY,
  });
  const channel = `chat:user:${ADA}`;
  await api.publishJson(channel, { type: "earlier" });
  const subscribedAt = async () => {
    const page = await connected(ADA);
    const subscription = page.newSubscription(channel);
    const position = new Promise<StreamPosition | undefined>((resolve) =>
      subscription.once("subscribed", ({ streamPosition }) => resolve(streamPosition)),
    );
    subscription.subscribe();
    const at = await position;
    page.disconnect();
    return at;
  };

  const quiet = (await chatStreamPositions([channel], api))[channel];
  expect(streamMovedSince(quiet, await subscribedAt())).toBe(false);

  const read = (await chatStreamPositions([channel], api))[channel];
  await api.publishJson(channel, { type: "conversation.activity.v1" });
  expect(streamMovedSince(read, await subscribedAt())).toBe(true);
}, 30_000);

test("an Agent status publication keeps a position on its channel", async () => {
  const api = createCentrifugoServerApi({
    COFORGE_CENTRIFUGO_API_URL: `http://127.0.0.1:${centrifugoPort}/api`,
    COFORGE_CENTRIFUGO_API_KEY: API_KEY,
  });
  const channel = "agentstatus:66666666-6666-4666-8666-666666666666";
  await api.publishJson(channel, { type: "agent:display" });
  await api.publish(channel, new TextEncoder().encode("{}"));
  expect((await chatStreamPositions([channel], api))[channel]?.offset).toBe(2);
}, 30_000);
