import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { storedShapeBuster } from "#src/features/cache-persistence/persisted-queries";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { devBrowserWorkspace } from "./helpers/browser-e2e";
import { gatedProxy } from "./helpers/gated-proxy";
import { openReadLanded } from "./helpers/open-unread-e2e";
import { serverFunctionIds } from "./helpers/server-function-ids";

const upstreamOrigin = Bun.env.COFORGE_E2E_WEB_URL;
if (!upstreamOrigin || !["localhost", "127.0.0.1"].includes(new URL(upstreamOrigin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/query-cache-persistence");

const CHAT_READS = ["loadChatLists", "loadPublicChannel"] as const;

const chatReadIds = serverFunctionIds(CHAT_READS);

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const proxy = gatedProxy(upstreamOrigin, chatReadIds);
const session = `query-cache-persistence-${process.pid}`;

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
const waitFor = (condition: string, ms = 20_000) =>
  Promise.race([
    browser("wait", "--fn", condition),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${condition}`)), ms),
    ),
  ]);
async function until(condition: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!(await evaluate<boolean>(condition))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${condition}`);
    await Bun.sleep(100);
  }
}
async function evaluate<T>(expression: string): Promise<T> {
  const printed = (
    await browser("eval", `(async () => JSON.stringify(await (${expression})))()`)
  ).trim();
  return JSON.parse(JSON.parse(printed)) as T;
}

const withStore = (mode: IDBTransactionMode, body: string) => `(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("coforge-query-cache");
    request.onupgradeneeded = () => request.result.createObjectStore("queries");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const store = db.transaction("queries", "${mode}").objectStore("queries");
  const result = await (async () => { ${body} })();
  db.close();
  return result;
})()`;
const storedKeys = () =>
  evaluate<string[]>(
    withStore(
      "readonly",
      `return new Promise((r) => { const q = store.getAllKeys(); q.onsuccess = () => r(q.result); });`,
    ),
  );
const store = (key: string, value: unknown) =>
  evaluate(
    withStore(
      "readwrite",
      `return new Promise((r) => { const q = store.put(${JSON.stringify(value)}, ${JSON.stringify(key)}); q.onsuccess = () => r(true); });`,
    ),
  );
const visible = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const stored = (key: string) =>
  withStore(
    "readonly",
    `return new Promise((r) => { const q = store.getKey(${JSON.stringify(key)}); q.onsuccess = () => r(q.result !== undefined); });`,
  );
async function whileHeld(watched: string[], body: () => Promise<void>) {
  proxy.hold(watched);
  try {
    await body();
  } catch (error) {
    proxy.mark("failed");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}
Server Function calls while held:
${proxy.report()}`,
      { cause: error },
    );
  } finally {
    proxy.release();
  }
}
async function pageIsUp(ready: string) {
  await waitFor(ready, 60_000);
  await browser("wait", "--load", "networkidle");
}
const chatLink = () =>
  `[...document.querySelectorAll("a")].find((a) => a.getAttribute("href") === ${JSON.stringify(workspacePath)})`;

let workspacePath = "";
let workspaceId = "";
const channelName = `e2e-cache-${process.pid}`;
let channelId = "";
const first = `First message ${process.pid}`;
const second = `Second message ${process.pid}`;

beforeAll(async () => {
  const own = await devBrowserWorkspace(db);
  workspacePath = `/en/w/${own.workspace.slug}`;
  workspaceId = own.workspaceId;
  const channel = await db.conversation.create({
    data: { workspaceId, channelName, description: "" },
  });
  channelId = channel.id;
  const member = await db.conversationMember.create({
    data: { conversationId: channelId, workspaceId, userId: DEV_BROWSER_USER.id },
  });
  await db.message.create({
    data: {
      workspaceId,
      conversationId: channelId,
      senderMemberId: member.id,
      sequence: 1,
      body: first,
    },
  });
  await mkdir(artifacts, { recursive: true });
  await browser("set", "viewport", "1440", "900");
});

afterAll(async () => {
  await db.message.deleteMany({ where: { conversationId: channelId } }).catch(() => {});
  await db.conversation.deleteMany({ where: { id: channelId } }).catch(() => {});
  await browser("close").catch(() => undefined);
  proxy.stop();
  await db.$disconnect();
});

const channelKey = (viewerId: string) =>
  `${viewerId}/tanstack-query-["conversation","channel","${channelId}"]`;

test("Chat opens from the browser's copy while its reads are outstanding, then the reads bring it up to date", async () => {
  await browser("open", `${proxy.origin}${workspacePath}/channel/${channelId}`);
  await waitFor(visible(first), 60_000);
  await until(stored(channelKey(DEV_BROWSER_USER.id)));

  const member = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: channelId, userId: DEV_BROWSER_USER.id },
  });
  await db.message.create({
    data: {
      workspaceId,
      conversationId: channelId,
      senderMemberId: member.id,
      sequence: 2,
      body: second,
    },
  });

  await browser("open", `${proxy.origin}${workspacePath}/members`);
  await pageIsUp(`!!(${chatLink()})`);
  await whileHeld([second], async () => {
    await browser("eval", "window.__stayedInThisDocument = true");
    await browser("eval", `${chatLink()}.click()`);

    await waitFor(visible(first));
    await waitFor(`document.querySelector('a[href*="/channel/${channelId}"]') !== null`);
    proxy.mark("on screen from storage");
    expect(proxy.held()).toBeGreaterThan(0);
    expect(await evaluate<boolean>("window.__stayedInThisDocument === true")).toBe(true);
    expect(await evaluate<boolean>(visible(second))).toBe(false);
    await browser("screenshot", join(artifacts, "from-the-browsers-copy.png"));
  });

  await waitFor(visible(second));
  await browser("screenshot", join(artifacts, "brought-up-to-date.png"));
}, 300_000);

test("a conversation read in one page load opens from the browser's copy without a divider over what was read", async () => {
  const third = `Third message ${process.pid}`;
  const member = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: channelId, userId: DEV_BROWSER_USER.id },
  });
  await db.message.create({
    data: {
      workspaceId,
      conversationId: channelId,
      senderMemberId: member.id,
      sequence: 3,
      body: third,
    },
  });
  await browser("open", `${proxy.origin}${workspacePath}/channel/${channelId}`);
  await pageIsUp(visible(third));
  const readThroughThird = async () =>
    (
      await db.conversationMember.findFirstOrThrow({
        where: { id: member.id },
        select: { readThroughSequence: true },
      })
    ).readThroughSequence === 3;
  const deadline = Date.now() + 30_000;
  while (!(await readThroughThird())) {
    if (Date.now() > deadline) throw new Error("the channel was not marked read through message 3");
    await Bun.sleep(200);
  }
  const storedThird = `(async () => JSON.stringify((await ${withStore(
    "readonly",
    `return new Promise((r) => { const q = store.get(${JSON.stringify(channelKey(DEV_BROWSER_USER.id))}); q.onsuccess = () => r(q.result); });`,
  )})?.state.data.pages ?? []).includes(${JSON.stringify(third)}))()`;
  await until(`${storedThird}.then((stored) => stored)`);
  await browser("open", `${proxy.origin}${workspacePath}/members`);
  await pageIsUp(`!!(${chatLink()})`);

  await whileHeld([third], async () => {
    await browser("eval", `${chatLink()}.click()`);
    await waitFor(visible(third));
    proxy.mark("on screen from storage");
    expect(proxy.held()).toBeGreaterThan(0);
    expect(
      await evaluate<boolean>(
        `document.querySelector('[role="separator"][aria-label="New messages"]') !== null`,
      ),
    ).toBe(false);
  });
  await waitFor(openReadLanded(channelId));
  expect(
    await evaluate<boolean>(
      `document.querySelector('[role="separator"][aria-label="New messages"]') !== null`,
    ),
  ).toBe(false);
  await browser("screenshot", join(artifacts, "read-then-reopened.png"));
}, 300_000);

test("a conversation read and left, then opened again in the same page load, shows no divider over what was read", async () => {
  const fourth = `Fourth message ${process.pid}`;
  const member = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: channelId, userId: DEV_BROWSER_USER.id },
  });
  await db.message.create({
    data: {
      workspaceId,
      conversationId: channelId,
      senderMemberId: member.id,
      sequence: 4,
      body: fourth,
    },
  });
  await browser("open", `${proxy.origin}${workspacePath}/channel/${channelId}`);
  await waitFor(visible(fourth), 60_000);
  const readBy = Date.now() + 30_000;
  while (
    (
      await db.conversationMember.findFirstOrThrow({
        where: { id: member.id },
        select: { readThroughSequence: true },
      })
    ).readThroughSequence !== 4
  ) {
    if (Date.now() > readBy) throw new Error("the channel was not marked read through message 4");
    await Bun.sleep(200);
  }
  await browser("eval", "window.__stayedInThisDocument = true");
  await browser(
    "eval",
    `[...document.querySelectorAll("a")].find((a) => a.textContent.trim() === "Members").click()`,
  );
  await waitFor(`location.pathname.endsWith("/members")`);
  await browser("eval", `${chatLink()}.click()`);
  await waitFor(visible(fourth));
  expect(await evaluate<boolean>("window.__stayedInThisDocument === true")).toBe(true);
  expect(
    await evaluate<boolean>(
      `document.querySelector('[role="separator"][aria-label="New messages"]') !== null`,
    ),
  ).toBe(false);
  await browser("screenshot", join(artifacts, "read-left-and-back.png"));
}, 300_000);

test("signing out removes what the browser kept", async () => {
  await browser("open", `${proxy.origin}${workspacePath}/channel/${channelId}`);
  await waitFor(visible(first), 60_000);
  await until(stored(channelKey(DEV_BROWSER_USER.id)));

  await browser("eval", `document.querySelector('button[aria-label^="Current user"]').click()`);
  await waitFor(
    `[...document.querySelectorAll('[role="menuitem"]')].some((i) => i.textContent.trim() === "Sign out")`,
  );
  await browser(
    "eval",
    `[...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent.trim() === "Sign out").click()`,
  );

  await waitFor(`document.body.innerText.includes("signed out")`);
  expect(await storedKeys()).toEqual([]);
}, 120_000);

test("another person on the same browser starts from nothing", async () => {
  const secret = `Someone else's secret ${process.pid}`;
  const health = await fetch(`${proxy.origin}/en/health`);
  expect(health.status).toBe(200);
  expect(health.headers.get("content-type")).toContain("text/plain");
  expect(await health.text()).toBe("ok");
  await browser("open", `${proxy.origin}/en/health`);
  const earlier = "11111111-1111-4111-8111-111111111111";
  await store(channelKey(earlier), {
    buster: storedShapeBuster,
    queryHash: JSON.stringify(["conversation", "channel", channelId]),
    queryKey: ["conversation", "channel", channelId],
    state: {
      data: {
        pages: [{ conversationId: channelId, messages: [{ id: "m", body: secret }] }],
        pageParams: [undefined],
      },
      dataUpdatedAt: Date.now(),
    },
  });
  expect(await storedKeys()).toEqual([channelKey(earlier)]);

  await browser("open", `${proxy.origin}${workspacePath}/channel/${channelId}`);
  await pageIsUp(visible(first));
  expect((await storedKeys()).filter((key) => key.startsWith(`${earlier}/`))).toEqual([]);
  expect(await evaluate<boolean>(visible(secret))).toBe(false);
}, 120_000);
