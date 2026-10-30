import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Centrifuge, State, SubscriptionState, type Subscription } from "centrifuge";
import { exportJWK, generateKeyPair } from "jose";

import {
  answerSubscriptionProxy,
  SUBSCRIPTION_LIFETIME_S,
  type BrowserSubscriptionAccess,
} from "#src/server/centrifugo/subscribe-proxy.server";
import { issueBrowserRealtimeToken } from "#src/server/auth/browser-realtime-token.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { chatStreamPositions } from "#src/server/conversations/chat-stream-positions.server";
import { streamMovedSince, type StreamPosition } from "#src/features/realtime/subscription-gap";

// A page subscribes without a token and Centrifugo asks the Web, through the subscribe and
// sub-refresh proxies exactly as `infra/centrifugo/config.yaml` declares them: a refusal is final,
// a Web that cannot answer is retried until it can, a grant that is lost ends at its refresh, and
// a daemon's connection is refused. A page connects with the Web's own connection token, whose
// meta Centrifugo must hand the proxy. It also checks the stream positions a page compares to
// tell whether a subscribe missed anything (task #348). Docker required: `mise run test:centrifugo`.

const API_KEY = "subscribe-proxy-integration";
const ADA = "33333333-3333-4333-8333-333333333333";
const GRACE = "44444444-4444-4444-8444-444444444444";
const CONVERSATION = "55555555-5555-4555-8555-555555555555";
const WORKSPACE = "66666666-6666-4666-8666-666666666666";
const AGENT = "77777777-7777-4777-8777-777777777777";

/** Who reads `CONVERSATION`; the conversation check throws while the Web is `down`. */
const readers = new Set([ADA]);
let down = false;
/** `AGENT`'s visibility; Grace made it, and Ada is a plain member of `WORKSPACE`. */
let agentVisibility = "public";
/** How much sooner than `SUBSCRIPTION_LIFETIME_S` a grant runs out. */
let shortenBy = 0;
/** How many times Centrifugo asked the sub-refresh proxy. */
let refreshes = 0;
const access: BrowserSubscriptionAccess = {
  workspaceRole: async (workspaceId, userId) =>
    workspaceId === WORKSPACE && userId === ADA ? "member" : undefined,
  workspaceAgent: async (workspaceId, agentId) =>
    workspaceId === WORKSPACE && agentId === AGENT
      ? { visibility: agentVisibility, ownerId: GRACE, systemKind: null }
      : undefined,
  readsConversation: async (conversationId, userId) => {
    if (down) throw new Error("database unavailable");
    return conversationId === CONVERSATION && readers.has(userId);
  },
};

let root: string;
let containerName: string;
let centrifugoPort: number;
let proxy: ReturnType<typeof Bun.serve>;
const clients: Centrifuge[] = [];
let signing: Record<string, string>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "coforge-subscribe-proxy-"));
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  const kid = "subscribe-proxy-test";
  signing = {
    COFORGE_WORKER_JWT_PRIVATE_JWK: JSON.stringify(await exportJWK(privateKey)),
    COFORGE_WORKER_JWT_KEY_ID: kid,
  };
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, use: "sig", alg: "EdDSA" }] };
  proxy = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/jwks") return Response.json(jwks);
      // A daemon connects through the connect proxy as its owner, its meta naming its Computer.
      if (path === "/connect") {
        const { data } = (await request.json()) as { data: { user: string } };
        return Response.json({
          result: { user: data.user, meta: { workspace_id: "w", computer_id: "computer" } },
        });
      }
      if (path === "/sub-refresh") refreshes++;
      return answerSubscriptionProxy(request, access, {
        refresh: path === "/sub-refresh",
        now: () => Date.now() - shortenBy * 1000,
      });
    },
  });
  const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  centrifugoPort = portProbe.port!;
  portProbe.stop(true);
  type Shipped = {
    channel: {
      proxy: Record<"subscribe" | "sub_refresh", Record<string, unknown>>;
      namespaces: { name: string }[];
    };
  };
  const shipped = Bun.YAML.parse(
    await Bun.file(join(import.meta.dir, "../../../infra/centrifugo/config.yaml")).text(),
  ) as Shipped;
  const shippedNamespaces = ["chat", "agent", "agentstatus"].map((name) => {
    const namespace = shipped.channel.namespaces.find((declared) => declared.name === name);
    if (!namespace) throw new Error(`infra/centrifugo/config.yaml declares no ${name} namespace`);
    // The publish proxy is not under test here.
    return { ...namespace, publish_proxy_enabled: false };
  });
  const origin = `http://host.docker.internal:${proxy.port}`;
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      health: { enabled: true },
      http_api: { key: API_KEY },
      log: { level: "error" },
      client: {
        allowed_origins: ["*"],
        token: {
          jwks_public_endpoint: `${origin}/jwks`,
          issuer: "coforge",
          audience: "coforge-centrifugo",
        },
        proxy: { connect: { enabled: true, endpoint: `${origin}/connect`, timeout: "5s" } },
      },
      channel: {
        proxy: {
          subscribe: {
            ...shipped.channel.proxy.subscribe,
            http: {},
            endpoint: `${origin}/subscribe`,
          },
          sub_refresh: {
            ...shipped.channel.proxy.sub_refresh,
            http: {},
            endpoint: `${origin}/sub-refresh`,
          },
        },
        namespaces: shippedNamespaces,
      },
    }),
    { mode: 0o644 },
  );
  containerName = `coforge-subscribe-proxy-${crypto.randomUUID()}`;
  const docker = Bun.spawnSync([
    "docker",
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--publish",
    `127.0.0.1:${centrifugoPort}:8000`,
    "--add-host",
    "host.docker.internal:host-gateway",
    "--volume",
    `${configPath}:/centrifugo/config.json:ro`,
    "centrifugo/centrifugo:v6.9.2",
    "centrifugo",
    "--config",
    "/centrifugo/config.json",
  ]);
  if (docker.exitCode !== 0) throw new Error(docker.stderr.toString());
  const deadline = Date.now() + 30_000;
  while (
    (await fetch(`http://127.0.0.1:${centrifugoPort}/health`).catch(() => null))?.ok !== true
  ) {
    if (Date.now() > deadline) throw new Error("Centrifugo did not become healthy");
    await Bun.sleep(100);
  }
}, 60_000);

afterAll(async () => {
  for (const client of clients) client.disconnect();
  if (containerName) Bun.spawnSync(["docker", "rm", "--force", containerName]);
  proxy?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
});

/** A page's connection with the Web's connection token, or a daemon's through the connect proxy. */
async function connected(user: string, daemon = false) {
  const client = new Centrifuge(
    `ws://127.0.0.1:${centrifugoPort}/connection/websocket`,
    daemon
      ? { data: { user } }
      : { token: await issueBrowserRealtimeToken({ userId: user, workspaceId: "w" }, signing) },
  );
  clients.push(client);
  client.connect();
  await client.ready(10_000);
  return client;
}

/** A subscription with every state it went through: `subscribed`, or `subscribing`/`unsubscribed`
 * with Centrifugo's code. */
function watched(client: Centrifuge, channel: string) {
  const subscription = client.newSubscription(channel, {
    minResubscribeDelay: 100,
    maxResubscribeDelay: 500,
  });
  const states: string[] = [];
  subscription.on("subscribed", () => states.push("subscribed"));
  subscription.on("subscribing", ({ code }) => states.push(`subscribing ${code}`));
  subscription.on("unsubscribed", ({ code }) => states.push(`unsubscribed ${code}`));
  subscription.on("error", ({ error }) => states.push(`error ${error.code}`));
  subscription.subscribe();
  return { subscription, states };
}

async function until(done: () => boolean, timeout: number) {
  const deadline = Date.now() + timeout;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(50);
  }
}

const settled = (subscription: Subscription) => () =>
  subscription.state === SubscriptionState.Subscribed ||
  subscription.state === SubscriptionState.Unsubscribed;

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

test("an Agent made private while a page shows it ends at the next refresh, and is not retried", async () => {
  // Task #348: pages hold every channel through the subscribe proxy, with no token to outlive the
  // grant. Ada sees Grace's Agent while it is public; once it is private she must stop hearing it.
  const ada = await connected(ADA);
  shortenBy = SUBSCRIPTION_LIFETIME_S - 2;
  try {
    const page = watched(ada, `agentstatus:${WORKSPACE}:${AGENT}`);
    await until(() => page.subscription.state === SubscriptionState.Subscribed, 5_000);
    agentVisibility = "private";
    await until(() => page.subscription.state === SubscriptionState.Unsubscribed, 90_000);
    // The refusal is final: nothing asks again, and the connection stays.
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

test("an Agent status publication reaches both its names, and the new one keeps a position", async () => {
  const api = createCentrifugoServerApi({
    COFORGE_CENTRIFUGO_API_URL: `http://127.0.0.1:${centrifugoPort}/api`,
    COFORGE_CENTRIFUGO_API_KEY: API_KEY,
  });
  const channel = "agentstatus:66666666-6666-4666-8666-666666666666";
  await api.publishJson(channel, { type: "agent:display" });
  await api.publish(channel, new TextEncoder().encode("{}"));
  expect((await chatStreamPositions([channel], api))[channel]?.offset).toBe(2);
}, 30_000);
