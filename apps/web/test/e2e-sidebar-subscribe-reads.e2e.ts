import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { serverFunctionIds, serverFunctionOf } from "./helpers/server-function-ids";
import {
  userConversationChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { CHAT_LIST_READS, type ChatListRead } from "#src/features/conversations/chat-list-reads";

const upstreamOrigin = Bun.env.COFORGE_E2E_WEB_URL;
if (!upstreamOrigin || !["localhost", "127.0.0.1"].includes(new URL(upstreamOrigin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
const centrifugoApiKey = Bun.env.COFORGE_CENTRIFUGO_API_KEY;
if (!centrifugoApiKey) throw new Error("COFORGE_CENTRIFUGO_API_KEY is required");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/sidebar-subscribe-reads");

const COUNTED = ["loadChatLists", "loadActivityNavAttention"] as const;
type Counted = (typeof COUNTED)[number];
type Reads = Record<Counted | ChatListRead, number>;
const NAMES = [...COUNTED, ...CHAT_LIST_READS];
const readsOf = (count: number): Reads =>
  Object.fromEntries(NAMES.map((name) => [name, count])) as Reads;

const listsOf = (url: URL): ChatListRead[] =>
  CHAT_LIST_READS.filter((list) => decodeURIComponent(url.search).includes(`"${list}"`));

const countedIds = serverFunctionIds(COUNTED);

type ProxySocket = { path: string; protocol?: string; upstream?: WebSocket; pending: unknown[] };

function countingProxy() {
  const reads = readsOf(0);
  const calls: { name: Counted; lists: ChatListRead[]; status: number; search: string }[] = [];
  const subscribing = new Set<string>();
  let watched: string[] = [];
  let gate: { opened: Promise<void>; release: () => void } | undefined;
  let framesHeld = false;
  let heldNow = 0;
  const heldFrames: { client: { data: ProxySocket }; message: string | Buffer }[] = [];
  const upstream = new URL(upstreamOrigin!);
  const centrifugo = new URL(centrifugoOrigin!);
  const server = Bun.serve<ProxySocket>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/e2e-blank")
        return new Response("<!doctype html><title>e2e</title>", {
          headers: { "content-type": "text/html" },
        });
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const protocol = request.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
        const upgraded = server.upgrade(request, {
          headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined,
          data: { path: url.pathname + url.search, protocol, pending: [] },
        });
        return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 500 });
      }
      const name = serverFunctionOf(countedIds, url);
      if (name) reads[name] += 1;
      const lists = name === "loadChatLists" ? listsOf(url) : [];
      for (const list of lists) reads[list] += 1;
      const forwardHeaders = new Headers(request.headers);
      forwardHeaders.set("origin", upstream.origin);
      forwardHeaders.delete("referer");
      const init: RequestInit & { duplex: "half" } = {
        method: request.method,
        headers: forwardHeaders,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
        duplex: "half",
      };
      const response = await fetch(upstream.origin + url.pathname + url.search, init);
      if (name) calls.push({ name, lists, status: response.status, search: url.search });
      const body = await response.arrayBuffer();
      if (lists.includes("channels") && gate) {
        heldNow += 1;
        await gate.opened;
        heldNow -= 1;
      }
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(body, { status: response.status, headers });
    },
    websocket: {
      open(client) {
        const target = client.data.path.startsWith("/connection/")
          ? `ws://${centrifugo.host}${client.data.path}`
          : `ws://${upstream.host}${client.data.path}`;
        const socket = new WebSocket(target, client.data.protocol);
        socket.binaryType = "arraybuffer";
        client.data.upstream = socket;
        socket.onopen = () => {
          for (const message of client.data.pending) socket.send(message as string);
          client.data.pending.length = 0;
        };
        socket.onmessage = (event) => client.send(event.data);
        socket.onclose = (event) => client.close(event.code, event.reason);
        socket.onerror = () => client.close(1011, "Upstream WebSocket error");
      },
      message(client, message) {
        if (client.data.path.startsWith("/connection/")) {
          const frame = typeof message === "string" ? Buffer.from(message) : message;
          const namesWatched = watched.some((channel) => frame.includes(channel));
          for (const channel of watched) if (frame.includes(channel)) subscribing.add(channel);
          if (namesWatched && framesHeld) {
            heldFrames.push({ client, message });
            return;
          }
        }
        const socket = client.data.upstream;
        if (socket?.readyState === WebSocket.OPEN) socket.send(message);
        else client.data.pending.push(message);
      },
      close(client) {
        client.data.upstream?.close();
      },
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    reads,
    calls,
    reset() {
      Object.assign(reads, readsOf(0));
      subscribing.clear();
    },
    watch(channels: string[]) {
      watched = channels;
    },
    subscribedToAll: () => watched.every((channel) => subscribing.has(channel)),
    hold() {
      let release = () => {};
      const opened = new Promise<void>((resolve) => (release = resolve));
      gate = { opened, release };
      framesHeld = true;
    },
    release() {
      gate?.release();
      gate = undefined;
    },
    releaseFrames() {
      framesHeld = false;
      for (const held of heldFrames.splice(0)) {
        const socket = held.client.data.upstream;
        if (socket?.readyState === WebSocket.OPEN) socket.send(held.message as string);
        else held.client.data.pending.push(held.message);
      }
    },
    held: () => heldNow,
    stop: () => server.stop(true),
  };
}

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const proxy = countingProxy();
const session = `sidebar-subscribe-reads-${process.pid}`;
const results: Record<string, Reads> = {};

async function browser(...args: string[]) {
  const child = Bun.spawn([browserPath!, "--session", session, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`Browser ${args[0]} failed: ${stderr}`);
  return stdout;
}

async function until(description: string, condition: () => boolean, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await Bun.sleep(50);
  }
}

async function publish(channel: string, data: unknown) {
  const response = await fetch(`${centrifugoOrigin}/api/publish`, {
    method: "POST",
    headers: { "x-api-key": centrifugoApiKey!, "content-type": "application/json" },
    body: JSON.stringify({ channel, data }),
  });
  if (!response.ok) throw new Error(`publish failed (${response.status})`);
  const body = (await response.json()) as { error?: unknown };
  if (body.error) throw new Error(`publish failed (${JSON.stringify(body.error)})`);
}

let workspacePath = "";
let workspaceId = "";

beforeAll(async () => {
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    orderBy: { createdAt: "asc" },
    include: { workspace: { select: { slug: true } } },
  });
  workspacePath = `/en/w/${membership.workspace.slug}`;
  workspaceId = membership.workspaceId;
  proxy.watch([
    workspaceConversationChannel(workspaceId),
    userConversationChannel(DEV_BROWSER_USER.id),
  ]);
  await mkdir(artifacts, { recursive: true });
  await browser("set", "viewport", "1440", "900");
});

afterAll(async () => {
  await writeFile(join(artifacts, "reads.json"), `${JSON.stringify(results, null, 2)}\n`);
  await writeFile(join(artifacts, "calls.json"), `${JSON.stringify(proxy.calls, null, 2)}\n`);
  proxy.release();
  proxy.releaseFrames();
  await browser("close").catch(() => undefined);
  proxy.stop();
  await db.$disconnect();
});

const chatIsLive = () =>
  until(
    "Chat's lists read and both signal channels subscribed",
    () => NAMES.every((name) => proxy.reads[name] >= 1) && proxy.subscribedToAll(),
    60_000,
  );

async function dropKeptQueryCache() {
  await browser("open", `${proxy.origin}/e2e-blank`);
  await browser(
    "eval",
    `(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("coforge-query-cache");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (!db.objectStoreNames.contains("queries")) {
        db.close();
        return true;
      }
      await new Promise((resolve, reject) => {
        const tx = db.transaction("queries", "readwrite");
        tx.objectStore("queries").clear();
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return true;
    })()`,
  );
}

test("with nothing published between the reads and the subscriptions, every list is read once", async () => {
  proxy.reset();
  const callsFrom = proxy.calls.length;
  await browser("open", `${proxy.origin}${workspacePath}/saved`);
  await chatIsLive();
  await browser("wait", "--load", "networkidle");
  results.quiet = { ...proxy.reads };
  const chatListCalls = proxy.calls
    .slice(callsFrom)
    .filter((call) => call.name === "loadChatLists");
  expect(chatListCalls.length).toBeLessThanOrEqual(2);
  expect(chatListCalls.every((call) => call.lists.length > 0)).toBe(true);
  expect(chatListCalls.flatMap((call) => call.lists).sort()).toEqual([...CHAT_LIST_READS].sort());
  expect({ ...proxy.reads, loadChatLists: 1 }).toEqual(readsOf(1));
}, 300_000);

test("a publication between the read and the subscriptions has the channel list read again", async () => {
  await dropKeptQueryCache();
  await browser("open", "about:blank");
  proxy.reset();
  proxy.hold();
  await browser("open", `${proxy.origin}${workspacePath}/saved`);
  await until("the channel list's answer to be held", () => proxy.held() > 0);
  await publish(workspaceConversationChannel(workspaceId), { type: "e2e.noop" });
  proxy.release();
  await browser("wait", "--load", "networkidle");
  proxy.releaseFrames();
  await until("the channel list read again", () => proxy.reads.channels >= 2);
  results.published = { ...proxy.reads };
  expect(proxy.reads.channels).toBe(2);
}, 300_000);

test("ten messages move the sidebar and the dot without a single read", async () => {
  await browser("open", `${proxy.origin}${workspacePath}/saved`);
  await chatIsLive();
  await browser("wait", "--load", "networkidle");
  const channel = await db.conversation.findFirstOrThrow({
    where: { workspaceId, channelName: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  proxy.reset();
  const before = { ...proxy.reads };
  for (let sequence = 1; sequence <= 10; sequence++) {
    await publish(userConversationChannel(DEV_BROWSER_USER.id), {
      type: "conversation.activity.v1",
      workspaceId,
      conversationId: channel.id,
      messageId: `e2e-activity-${sequence}`,
      sequence,
      kind: "channel",
      createdAt: new Date().toISOString(),
      preview: `message ${sequence}`,
      sender: { kind: "user", name: "Someone Else" },
      senderUserId: "e2e-someone-else",
    });
  }
  await browser("wait", "--load", "networkidle");

  results["activity:before"] = before;
  results["activity:after"] = { ...proxy.reads };
  expect(proxy.reads.loadChatLists).toBe(0);
  expect(proxy.reads.loadActivityNavAttention).toBe(0);
}, 300_000);
