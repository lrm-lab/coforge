import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { State, SubscriptionState, type Centrifuge } from "centrifuge";

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
  type SubscribeProxyHarnessResources,
} from "./helpers/subscribe-proxy-harness";

const API_KEY = SUBSCRIBE_PROXY_API_KEY;
const ADA = "33333333-3333-4333-8333-333333333333";
const GRACE = "44444444-4444-4444-8444-444444444444";
const CONVERSATION = "55555555-5555-4555-8555-555555555555";
const WORKSPACE = "66666666-6666-4666-8666-666666666666";
const AGENT = "77777777-7777-4777-8777-777777777777";
const RENEW_USER = "33333333-3333-4333-8333-333333333331";
const REVOKED_USER = "33333333-3333-4333-8333-333333333332";
const DEMOTED_USER = "33333333-3333-4333-8333-333333333334";
const RENEW_CONVERSATION = "55555555-5555-4555-8555-555555555551";
const REVOKED_CONVERSATION = "55555555-5555-4555-8555-555555555552";
const PRIVATE_WORKSPACE = "66666666-6666-4666-8666-666666666661";
const PRIVATE_AGENT = "77777777-7777-4777-8777-777777777771";

type RefreshReceipt = {
  user: string;
  channel: string;
  pageMeta: boolean;
  expired: boolean;
  expireAt?: number;
};

const conversationReaders = new Map<string, Set<string>>([[CONVERSATION, new Set([ADA])]]);
let down = false;
const workspaceRoles = new Map<string, Map<string, "admin" | "member">>([
  [WORKSPACE, new Map([[ADA, "member"]])],
]);
const workspaceAgents = new Map<
  string,
  Map<string, { visibility: string; ownerId: string; systemKind: string | null }>
>([[WORKSPACE, new Map([[AGENT, { visibility: "public", ownerId: GRACE, systemKind: null }]])]]);
const shortLivedChannels = new Set<string>();
const refreshReceipts = new Map<string, RefreshReceipt[]>();
const access: BrowserSubscriptionAccess = {
  workspaceRole: async (workspaceId, userId) => workspaceRoles.get(workspaceId)?.get(userId),
  workspaceAgent: async (workspaceId, agentId) => workspaceAgents.get(workspaceId)?.get(agentId),
  readsArtifact: async () => false,
  readsConversation: async (conversationId, userId) => {
    if (down) throw new Error("database unavailable");
    return conversationReaders.get(conversationId)?.has(userId) ?? false;
  },
};

let harness: SubscribeProxyHarness;
let centrifugoPort: number;
const connected = (user: string, daemon = false) => harness.connected(user, daemon);

beforeAll(async () => {
  harness = await startSubscribeProxyHarness(async (request, refresh) => {
    const raw = await request.text();
    const parsed = (() => {
      try {
        return JSON.parse(raw) as { user?: unknown; channel?: unknown; meta?: unknown };
      } catch {
        return undefined;
      }
    })();
    const channel = typeof parsed?.channel === "string" ? parsed.channel : "";
    const shortenBy = shortLivedChannels.has(channel) ? SUBSCRIPTION_LIFETIME_S - 2 : 0;
    const response = await answerSubscriptionProxy(
      new Request(request.url, { method: request.method, headers: request.headers, body: raw }),
      access,
      {
        refresh,
        now: () => Date.now() - shortenBy * 1000,
      },
    );
    if (refresh && channel) {
      const answer = (await response
        .clone()
        .json()
        .catch(() => undefined)) as
        | { result?: { expired?: boolean; expire_at?: number } }
        | undefined;
      const meta = parsed?.meta as { page?: unknown } | undefined;
      const list = refreshReceipts.get(channel) ?? [];
      list.push({
        user: typeof parsed?.user === "string" ? parsed.user : "",
        channel,
        pageMeta: meta?.page === true,
        expired: answer?.result?.expired === true,
        expireAt: answer?.result?.expire_at,
      });
      refreshReceipts.set(channel, list);
    }
    return response;
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

test("a public Agent's own status channel is refused; the workspace channel carries it", async () => {
  const ada = await connected(ADA);
  const page = watched(ada, `agentstatus:${WORKSPACE}:${AGENT}`);
  await until(() => page.subscription.state === SubscriptionState.Unsubscribed, 5_000);
  expect(page.states).toEqual(["subscribing 0", "unsubscribed 403"]);
  const workspacePage = watched(ada, `agentstatus:${WORKSPACE}`);
  await until(() => workspacePage.subscription.state === SubscriptionState.Subscribed, 5_000);
  expect(ada.state).toBe(State.Connected);
}, 30_000);

describe("subscription refresh expiry window", () => {
  test.concurrent("a grant still held is renewed by the refresh, which sees the page's connection", async () => {
    const channel = `chat:${RENEW_CONVERSATION}`;
    let client: Centrifuge | undefined;
    try {
      conversationReaders.set(RENEW_CONVERSATION, new Set([RENEW_USER]));
      shortLivedChannels.add(channel);
      refreshReceipts.set(channel, []);
      client = await connected(RENEW_USER);
      const page = watched(client, channel);
      await until(() => page.subscription.state === SubscriptionState.Subscribed, 5_000);
      await until(() => (refreshReceipts.get(channel)?.length ?? 0) > 0, 90_000);
      await Bun.sleep(1_000);
      const receipts = refreshReceipts.get(channel) ?? [];
      expect(receipts.length).toBeGreaterThan(0);
      expect(receipts[0]).toMatchObject({
        user: RENEW_USER,
        channel,
        pageMeta: true,
        expired: false,
      });
      expect(receipts[0]?.expireAt).toBeGreaterThan(0);
      expect(page.states).toEqual(["subscribing 0", "subscribed"]);
      expect(client.state).toBe(State.Connected);
    } finally {
      client?.disconnect();
      shortLivedChannels.delete(channel);
      conversationReaders.delete(RENEW_CONVERSATION);
      refreshReceipts.delete(channel);
    }
  }, 120_000);

  test.concurrent("a grant that is lost ends when it is next refreshed", async () => {
    const channel = `chat:${REVOKED_CONVERSATION}`;
    let client: Centrifuge | undefined;
    try {
      conversationReaders.set(REVOKED_CONVERSATION, new Set([REVOKED_USER]));
      shortLivedChannels.add(channel);
      refreshReceipts.set(channel, []);
      client = await connected(REVOKED_USER);
      const page = watched(client, channel);
      await until(() => page.subscription.state === SubscriptionState.Subscribed, 5_000);
      conversationReaders.get(REVOKED_CONVERSATION)?.delete(REVOKED_USER);
      await until(() => page.subscription.state === SubscriptionState.Unsubscribed, 90_000);
      await Bun.sleep(2_000);
      const receipts = refreshReceipts.get(channel) ?? [];
      expect(receipts.length).toBeGreaterThan(0);
      expect(receipts[0]).toMatchObject({
        user: REVOKED_USER,
        channel,
        pageMeta: true,
        expired: true,
      });
      expect(page.states).toEqual([
        "subscribing 0",
        "subscribed",
        "subscribing 2501",
        "unsubscribed 403",
      ]);
      expect(client.state).toBe(State.Connected);
    } finally {
      client?.disconnect();
      shortLivedChannels.delete(channel);
      conversationReaders.delete(REVOKED_CONVERSATION);
      refreshReceipts.delete(channel);
    }
  }, 120_000);

  test.concurrent("a private Agent's status channel ends at the next refresh when the viewer loses the role", async () => {
    const channel = `agentstatus:${PRIVATE_WORKSPACE}:${PRIVATE_AGENT}`;
    let client: Centrifuge | undefined;
    try {
      workspaceRoles.set(PRIVATE_WORKSPACE, new Map([[DEMOTED_USER, "admin"]]));
      workspaceAgents.set(
        PRIVATE_WORKSPACE,
        new Map([[PRIVATE_AGENT, { visibility: "private", ownerId: GRACE, systemKind: null }]]),
      );
      shortLivedChannels.add(channel);
      refreshReceipts.set(channel, []);
      client = await connected(DEMOTED_USER);
      const page = watched(client, channel);
      await until(() => page.subscription.state === SubscriptionState.Subscribed, 5_000);
      workspaceRoles.get(PRIVATE_WORKSPACE)?.set(DEMOTED_USER, "member");
      await until(() => page.subscription.state === SubscriptionState.Unsubscribed, 90_000);
      await Bun.sleep(2_000);
      const receipts = refreshReceipts.get(channel) ?? [];
      expect(receipts.length).toBeGreaterThan(0);
      expect(receipts[0]).toMatchObject({
        user: DEMOTED_USER,
        channel,
        pageMeta: true,
        expired: true,
      });
      expect(page.states).toEqual([
        "subscribing 0",
        "subscribed",
        "subscribing 2501",
        "unsubscribed 403",
      ]);
      expect(client.state).toBe(State.Connected);
    } finally {
      client?.disconnect();
      shortLivedChannels.delete(channel);
      workspaceRoles.delete(PRIVATE_WORKSPACE);
      workspaceAgents.delete(PRIVATE_WORKSPACE);
      refreshReceipts.delete(channel);
    }
  }, 120_000);
});

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

test("startup failure cleans up the temp directory, proxy, and container", async () => {
  let resources: SubscribeProxyHarnessResources | undefined;

  await expect(
    startSubscribeProxyHarness(async () => new Response(null, { status: 500 }), {
      healthTimeoutMs: 0,
      onResources: (created) => {
        resources = created;
      },
    }),
  ).rejects.toThrow("Centrifugo did not become healthy");

  expect(resources).toBeDefined();
  expect(existsSync(resources!.root)).toBe(false);
  const ps = Bun.spawnSync([
    "docker",
    "ps",
    "-a",
    "--filter",
    `name=^/${resources!.containerName}$`,
    "--format",
    "{{.Names}}",
  ]);
  expect(ps.exitCode).toBe(0);
  expect(ps.stdout.toString().trim()).toBe("");
  await expect(fetch(`http://127.0.0.1:${resources!.proxyPort}/jwks`)).rejects.toThrow();
}, 30_000);
