import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Centrifuge, SubscriptionState, type Subscription } from "centrifuge";
import { exportJWK, generateKeyPair } from "jose";

import { issueBrowserRealtimeToken } from "#src/server/auth/browser-realtime-token.server";

export const SUBSCRIBE_PROXY_API_KEY = "subscribe-proxy-integration";

export type SubscribeProxyHarness = {
  centrifugoPort: number;
  connected(user: string, daemon?: boolean): Promise<Centrifuge>;
  stop(): Promise<void>;
};

export type SubscribeProxyHarnessResources = {
  root: string;
  proxyPort: number;
  containerName: string;
};

export type StartSubscribeProxyHarnessOptions = {
  healthTimeoutMs?: number;
  onResources?: (resources: SubscribeProxyHarnessResources) => void;
};

export async function startSubscribeProxyHarness(
  onSubscriptionProxy: (request: Request, refresh: boolean) => Promise<Response>,
  options: StartSubscribeProxyHarnessOptions = {},
): Promise<SubscribeProxyHarness> {
  const clients: Centrifuge[] = [];
  let root: string | undefined;
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  let containerName: string | undefined;

  async function stop() {
    for (const client of clients) client.disconnect();
    clients.length = 0;
    if (containerName) {
      Bun.spawnSync(["docker", "rm", "--force", containerName]);
      containerName = undefined;
    }
    if (proxy) {
      proxy.stop(true);
      proxy = undefined;
    }
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  }

  try {
    root = await mkdtemp(join(tmpdir(), "coforge-subscribe-proxy-"));
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
    const kid = "subscribe-proxy-test";
    const signing: Record<string, string> = {
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
        if (path === "/connect") {
          const { data } = (await request.json()) as { data: { user: string } };
          return Response.json({
            result: { user: data.user, meta: { workspace_id: "w", computer_id: "computer" } },
          });
        }
        return onSubscriptionProxy(request, path === "/sub-refresh");
      },
    });
    const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const centrifugoPort = portProbe.port!;
    portProbe.stop(true);
    type Shipped = {
      channel: {
        proxy: Record<"subscribe" | "sub_refresh", Record<string, unknown>>;
        namespaces: { name: string }[];
      };
    };
    const shipped = Bun.YAML.parse(
      await Bun.file(join(import.meta.dir, "../../../../infra/centrifugo/config.yaml")).text(),
    ) as Shipped;
    const shippedNamespaces = ["chat", "agent", "agentstatus"].map((name) => {
      const namespace = shipped.channel.namespaces.find((declared) => declared.name === name);
      if (!namespace) throw new Error(`infra/centrifugo/config.yaml declares no ${name} namespace`);
      return { ...namespace, publish_proxy_enabled: false };
    });
    const origin = `http://host.docker.internal:${proxy.port}`;
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        health: { enabled: true },
        http_api: { key: SUBSCRIBE_PROXY_API_KEY },
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
    const name = `coforge-subscribe-proxy-${crypto.randomUUID()}`;
    containerName = name;
    const docker = Bun.spawnSync([
      "docker",
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
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
    options.onResources?.({ root, proxyPort: proxy.port!, containerName: name });
    const deadline = Date.now() + (options.healthTimeoutMs ?? 30_000);
    while (true) {
      if (Date.now() >= deadline) throw new Error("Centrifugo did not become healthy");
      if (
        (await fetch(`http://127.0.0.1:${centrifugoPort}/health`).catch(() => null))?.ok === true
      ) {
        break;
      }
      await Bun.sleep(100);
    }
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
    return { centrifugoPort, connected, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export function watched(client: Centrifuge, channel: string) {
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

export async function until(done: () => boolean, timeout: number) {
  const deadline = Date.now() + timeout;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(50);
  }
}

export const settled = (subscription: Subscription) => () =>
  subscription.state === SubscriptionState.Subscribed ||
  subscription.state === SubscriptionState.Unsubscribed;
