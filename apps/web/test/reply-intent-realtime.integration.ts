/**
 * Real Centrifugo transport capture. Requires Docker and cached centrifugo/centrifugo:v6.9.2.
 * Run: mise run test:file -- ./apps/web/test/reply-intent-realtime.integration.ts
 * Owns a temporary config, JWKS/proxy server and container; finally removes all of them.
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import { Centrifuge } from "centrifuge/build/protobuf";
import {
  encodeAgentReplyIntent,
  decodeAgentActivityFrame,
} from "@lrm/coforge-sdk/internal/reply-intent";
import { handleAgentActivityPublication } from "#src/server/agents/agent-activity-publish.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import {
  issueBrowserRealtimeToken,
  issueConversationRealtimeToken,
  issueAgentActivitySubscriptionToken,
} from "#src/server/auth/browser-realtime-token.server";

async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`Docker ${args[0]} failed: ${error}`);
  return output.trim();
}

function event<T>(listen: (resolve: (value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Centrifugo event timed out")), 5_000);
    listen((value) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
}

test("real routing delivers start/end only to the conversation, with no history or Activity copy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-reply-intent-"));
  const name = `coforge-reply-intent-${crypto.randomUUID()}`;
  const clients: Centrifuge[] = [];
  // A client the server drops mid-test otherwise reports only `disconnected`: keep the
  // server's own code/reason so the CI log names the denial instead.
  const disconnects: { userId: string; code: number; reason: string }[] = [];
  let containerStarted = false;
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  try {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
    const kid = "reply-intent-test";
    const environment = {
      COFORGE_WORKER_JWT_PRIVATE_JWK: JSON.stringify(await exportJWK(privateKey)),
      COFORGE_WORKER_JWT_KEY_ID: kid,
    };
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, use: "sig", alg: "EdDSA" }] };
    const secret = crypto.randomUUID();
    const apiKey = crypto.randomUUID();
    let api: ReturnType<typeof createCentrifugoServerApi>;
    let observed = 0;
    const routed: string[] = [];
    proxy = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/jwks") return Response.json(jwks);
        if (path === "/connect")
          return Response.json({
            result: { user: "daemon", meta: { workspace_id: "w", computer_id: "computer" } },
          });
        return handleAgentActivityPublication(request, {
          proxySecret: secret,
          agentBelongsToWorkspace: async (w, a) => w === "w" && a === "a",
          agentBelongsToComputer: async (w, a, c) => w === "w" && a === "a" && c === "computer",
          computerBelongsToWorkspace: async (w, c) => w === "w" && c === "computer",
          agentVisibility: async () => "public",
          resolveReplyTarget: async ({ target }) =>
            target === "#general:root" ? { conversationId: "c", threadRootId: "root" } : undefined,
          publish: async (channel, data, options) => {
            routed.push(channel);
            await api.publish(channel, data, options);
          },
          observe: async () => {
            observed++;
          },
        });
      },
    });
    const origin = `http://host.docker.internal:${proxy.port}`;
    const config = join(directory, "config.json");
    await writeFile(
      config,
      JSON.stringify({
        client: {
          allowed_origins: ["*"],
          token: {
            jwks_public_endpoint: `${origin}/jwks`,
            issuer: "coforge",
            audience: "coforge-centrifugo",
          },
          proxy: { connect: { enabled: true, endpoint: `${origin}/connect` } },
        },
        http_api: { key: apiKey },
        channel: {
          proxy: {
            publish: {
              endpoint: `${origin}/publish`,
              binary_encoding: true,
              include_connection_meta: true,
              http: { static_headers: { "X-CoForge-Centrifugo-Proxy-Secret": secret } },
            },
          },
          namespaces: [
            { name: "chat", history_size: 200, history_ttl: "5m", force_recovery: true },
            { name: "agent", publish_proxy_enabled: true, publication_data_format: "binary" },
          ],
        },
      }),
      { mode: 0o600 },
    );
    await docker(
      "run",
      "-d",
      "--add-host",
      "host.docker.internal:host-gateway",
      "--name",
      name,
      "-p",
      "127.0.0.1::8000",
      "-v",
      `${config}:/centrifugo/config.json:ro`,
      "centrifugo/centrifugo:v6.9.2",
      "centrifugo",
      "-c",
      "/centrifugo/config.json",
    );
    containerStarted = true;
    const port = (await docker("port", name, "8000")).split(":").at(-1);
    const endpoint = `http://127.0.0.1:${port}`;
    api = createCentrifugoServerApi({
      COFORGE_CENTRIFUGO_API_URL: `${endpoint}/api`,
      COFORGE_CENTRIFUGO_API_KEY: apiKey,
    });
    // The container accepts connections before Centrifugo is answering: on a cold CI runner a
    // first request can hit a half-up server. Wait for any HTTP answer before clients dial.
    {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const up = await fetch(endpoint).then(
          () => true,
          () => false,
        );
        if (up) break;
        if (Date.now() > deadline) throw new Error("Centrifugo container did not come up");
        await Bun.sleep(100);
      }
    }
    async function connection(userId: string) {
      const client = new Centrifuge(`${endpoint.replace("http", "ws")}/connection/websocket`, {
        token:
          userId === "daemon"
            ? undefined
            : await issueBrowserRealtimeToken({ userId, workspaceId: "w" }, environment),
        timeout: 5_000,
      });
      clients.push(client);
      client.on("disconnected", ({ code, reason }) => {
        disconnects.push({ userId, code, reason });
      });
      client.connect();
      await client.ready(15_000);
      return client;
    }
    const viewer = await connection("viewer");
    const conversation = viewer.newSubscription("chat:c", {
      token: await issueConversationRealtimeToken(
        { userId: "viewer", conversationId: "c" },
        environment,
      ),
      recoverable: true,
      positioned: true,
    });
    const received: unknown[] = [];
    let acknowledge: (() => void) | undefined;
    conversation.on("publication", ({ data }) => {
      received.push(data);
      acknowledge?.();
    });
    conversation.subscribe();
    await conversation.ready();
    const activity = viewer.newSubscription("agent:activity:w", {
      token: await issueAgentActivitySubscriptionToken(
        { userId: "viewer", workspaceId: "w" },
        environment,
      ),
    });
    const activityFrames: unknown[] = [];
    let activityMarker: (() => void) | undefined;
    activity.on("publication", ({ data }) => {
      activityFrames.push(data);
      activityMarker?.();
    });
    activity.subscribe();
    await activity.ready();
    const daemon = await connection("daemon");
    for (const phase of ["start", "end"] as const) {
      const delivered = event<void>((resolve) => {
        acknowledge = resolve;
      });
      const frame = encodeAgentReplyIntent({
        protocolMajor: 1,
        requestId: phase,
        workspaceId: "w",
        agentId: "a",
        observedAtMs: Date.now(),
        intent: {
          phase,
          callId: "call",
          target: "#general:root",
          ...(phase === "start" ? { early: true } : {}),
        },
      });
      // Re-routing answers with a publish-proxy error so Centrifugo drops the original frame.
      await expect(daemon.publish("agent:activity:w", frame)).rejects.toMatchObject({ code: 1000 });
      await delivered;
    }
    expect(received.map((data) => decodeAgentActivityFrame(data as Uint8Array))).toMatchObject([
      {
        replyIntent: {
          agentId: "a",
          intent: {
            phase: "start",
            callId: "call",
            conversationId: "c",
            threadRootId: "root",
            early: true,
          },
        },
      },
      { replyIntent: { agentId: "a", intent: { phase: "end", callId: "call" } } },
    ]);
    const last = decodeAgentActivityFrame(received[1] as Uint8Array);
    expect("replyIntent" in last && last.replyIntent.intent).toEqual({
      phase: "end",
      callId: "call",
    });
    const marker = event<void>((resolve) => {
      activityMarker = resolve;
    });
    await api.publishJson("agent:activity:w", { marker: true });
    await marker;
    expect(activityFrames).toHaveLength(1);
    expect(routed).toEqual(["chat:c", "chat:c"]);
    expect(observed).toBe(0);
    const history = (await fetch(`${endpoint}/api`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ method: "history", params: { channel: "chat:c", limit: 100 } }),
    }).then((response) => response.json())) as { result: { publications?: unknown[] } };
    expect(history.result.publications ?? []).toEqual([]);
    // A denied subscription drops the whole client, which rejects its in-flight subscribe
    // command with `clientDisconnected` — a rejection the client library leaves unhandled.
    // That is the denial under test, not a defect: contain it for exactly this check.
    const denialRejection = (reason: unknown) => {
      if (typeof reason === "object" && reason !== null && (reason as { code?: unknown }).code === 3)
        return;
      throw reason;
    };
    let channelDenial = 0;
    let userDenial = 0;
    process.on("unhandledRejection", denialRejection);
    try {
      const outsider = viewer.newSubscription("chat:another", {
        token: await issueConversationRealtimeToken(
          { userId: "viewer", conversationId: "c" },
          environment,
        ),
      });
      const rejectedChannel = event<number>((resolve) => {
        outsider.once("unsubscribed", ({ code }) => resolve(code));
        viewer.once("disconnected", ({ code }) => resolve(code));
      });
      outsider.subscribe();
      void outsider.ready().catch(() => {});
      channelDenial = await rejectedChannel;
      expect(channelDenial).toBe(3500);
      const otherUser = await connection("other");
      const stolen = otherUser.newSubscription("chat:c", {
        token: await issueConversationRealtimeToken(
          { userId: "viewer", conversationId: "c" },
          environment,
        ),
      });
      const rejectedUser = event<number>((resolve) => {
        stolen.once("unsubscribed", ({ code }) => resolve(code));
        otherUser.once("disconnected", ({ code }) => resolve(code));
      });
      stolen.subscribe();
      void stolen.ready().catch(() => {});
      userDenial = await rejectedUser;
      expect(userDenial).toBe(3500);
    } finally {
      process.off("unhandledRejection", denialRejection);
    }
    console.info(
      JSON.stringify({
        capture: "reply-intent",
        routed,
        phases: ["start", "end"],
        activityCopies: 0,
        history: 0,
        boundChannelAndUser: true,
        deniedChannelCode: channelDenial,
        deniedUserCode: userDenial,
        disconnects,
      }),
    );
  } finally {
    if (disconnects.length)
      console.info(JSON.stringify({ capture: "reply-intent-disconnects", disconnects }));
    for (const client of clients) client.disconnect();
    try {
      if (containerStarted) await docker("rm", "-f", name);
    } finally {
      proxy?.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 120_000);
