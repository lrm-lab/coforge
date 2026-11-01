import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { waitFor } from "./helpers/activity-inbox-e2e";
import { openReadLanded, openReadState } from "./helpers/open-unread-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * A channel read on another device opens here without a "New messages" divider over what was read
 * there, from the window this device holds in memory and from the one it stored alike: the divider
 * comes from the open's own read of where the viewer's unread starts (task #378), never from a
 * window held from earlier.
 *
 * Two devices are two `agent-browser` sessions, each its own profile (cookies, IndexedDB), signed in
 * as the same dev user. Opt-in like the other browser E2Es: a real local Web built with
 * `bun run build` and served from `.output/` (`COFORGE_E2E_WEB_URL`), a real Centrifugo with this
 * repository's `infra/centrifugo/config.yaml` whose proxies and JWKS point at that Web
 * (`COFORGE_E2E_CENTRIFUGO_URL`), the Web's `COFORGE_CENTRIFUGO_API_URL` pointing at the same
 * Centrifugo, `agent-browser`, and the dev user an owner of its Workspace (seed-dev). Both browsers
 * talk to a proxy in this test that forwards `/connection/*` to Centrifugo and the rest to the Web.
 * Each run seeds two channels and a second member who writes in them, and removes them afterwards.
 * Screenshots are written under `.amp/e2e/read-cursor-elsewhere/`.
 */
const upstreamOrigin = Bun.env.COFORGE_E2E_WEB_URL;
if (!upstreamOrigin || !["localhost", "127.0.0.1"].includes(new URL(upstreamOrigin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/read-cursor-elsewhere");

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const proxy = sameOriginProxy(upstreamOrigin!, centrifugoOrigin!);

/** One device: its own `agent-browser` session, so its own cookies and IndexedDB. */
function device(name: string) {
  const session = `read-cursor-elsewhere-${name}-${process.pid}`;
  async function run(...args: string[]) {
    const child = Bun.spawn([browserPath!, "--session", session, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${name}: ${args[0]} failed: ${stderr}`);
    return stdout;
  }
  /** Runs an async expression in the page and parses the JSON it returns. */
  async function evaluate<T>(expression: string): Promise<T> {
    const printed = (
      await run("eval", `(async () => JSON.stringify(await (${expression})))()`)
    ).trim();
    return JSON.parse(JSON.parse(printed)) as T;
  }
  /** Polls an asynchronous condition in the page (`wait --fn` takes a Promise as truthy). */
  async function until(condition: string, ms = 30_000) {
    const deadline = Date.now() + ms;
    while (!(await evaluate<boolean>(condition))) {
      if (Date.now() > deadline) throw new Error(`${name}: timed out waiting for ${condition}`);
      await Bun.sleep(100);
    }
  }
  return { run, evaluate, until };
}
const here = device("here");
const elsewhere = device("elsewhere");

const suffix = String(process.pid);
let workspacePath = "";
let workspaceId = "";
let readId = "";
let otherId = "";
let writerUserId = "";
let writerMemberId = "";
let viewerMemberId = "";
const body = (n: number) => `Read-cursor message ${n} ${suffix}`;
const otherBody = `Somewhere else ${suffix}`;

const visible = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const dividerShown = `document.querySelector('[role="separator"][aria-label="New messages"]') !== null`;
/** Whether this device has stored the channel's window, straight from IndexedDB. */
const storedWindow = () => `(async () => {
  const db = await new Promise((r, j) => { const q = indexedDB.open("coforge-query-cache"); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
  const row = await new Promise((r) => { const q = db.transaction("queries").objectStore("queries").get(${JSON.stringify(
    `${DEV_BROWSER_USER.id}/tanstack-query-["conversation","channel","${readId}"]`,
  )}); q.onsuccess = () => r(q.result); });
  db.close();
  return row?.state?.data?.pages?.length > 0;
})()`;
const clickChannel = (id: string) => `document.querySelector('a[href*="/channel/${id}"]').click()`;

async function post(conversationId: string, sequence: number, text: string) {
  await db.message.create({
    data: { workspaceId, conversationId, senderMemberId: writerMemberId, sequence, body: text },
  });
}

/** The viewer's read cursor, written by the other device, has reached message `sequence`. */
async function readThrough(sequence: number) {
  await waitFor(
    async () =>
      (await db.conversationMember.findUniqueOrThrow({ where: { id: viewerMemberId } }))
        .readThroughSequence === sequence,
  );
}

beforeAll(async () => {
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: { select: { slug: true } } },
  });
  workspacePath = `/en/w/${membership.workspace.slug}`;
  workspaceId = membership.workspaceId;
  const writer = await db.user.create({
    data: { displayName: `e2erc${suffix}`, username: `e2erc${suffix}` },
  });
  writerUserId = writer.id;
  await db.workspaceMembership.create({ data: { workspaceId, userId: writer.id } });
  const read = await db.conversation.create({
    data: { workspaceId, channelName: `e2e-read-${suffix}`, description: "" },
  });
  const other = await db.conversation.create({
    data: { workspaceId, channelName: `e2e-other-${suffix}`, description: "" },
  });
  readId = read.id;
  otherId = other.id;
  const writerMember = await db.conversationMember.create({
    data: { conversationId: readId, workspaceId, userId: writer.id },
  });
  writerMemberId = writerMember.id;
  await db.conversationMember.create({
    data: { conversationId: otherId, workspaceId, userId: writer.id },
  });
  // The viewer has read the first three messages; nothing is unread when the test starts.
  const viewer = await db.conversationMember.create({
    data: { conversationId: readId, workspaceId, userId: DEV_BROWSER_USER.id },
  });
  viewerMemberId = viewer.id;
  await db.conversationMember.create({
    data: { conversationId: otherId, workspaceId, userId: DEV_BROWSER_USER.id },
  });
  for (const n of [1, 2, 3]) await post(readId, n, body(n));
  await db.conversationMember.update({
    where: { id: viewerMemberId },
    data: { readThroughSequence: 3 },
  });
  const writerInOther = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: otherId, userId: writer.id },
  });
  await db.message.create({
    data: {
      workspaceId,
      conversationId: otherId,
      senderMemberId: writerInOther.id,
      sequence: 1,
      body: otherBody,
    },
  });
  await mkdir(artifacts, { recursive: true });
  for (const one of [here, elsewhere]) await one.run("set", "viewport", "1440", "900");
});

afterAll(async () => {
  for (const one of [here, elsewhere]) await one.run("close").catch(() => undefined);
  proxy.stop();
  await db.message.deleteMany({ where: { conversationId: { in: [readId, otherId] } } });
  await db.conversationMember.deleteMany({ where: { conversationId: { in: [readId, otherId] } } });
  await db.conversation.deleteMany({ where: { id: { in: [readId, otherId] } } });
  await db.workspaceMembership.deleteMany({ where: { userId: writerUserId } });
  // Joining the workspace gave the writer a private assistant (`WorkspaceAssistantOnboarding`).
  await db.agent.deleteMany({ where: { ownerId: writerUserId } });
  await db.user.deleteMany({ where: { id: writerUserId } });
  await db.$disconnect();
});

test("a channel read on another device opens here without a divider over what was read", async () => {
  // This device reads the channel, stores its window, and moves on to another channel.
  await here.run("open", `${proxy.origin}${workspacePath}/channel/${readId}`);
  await here.until(visible(body(3)), 60_000);
  await here.until(`${storedWindow()}.then((stored) => stored)`);
  await here.run("eval", clickChannel(otherId));
  await here.until(visible(otherBody));

  // Two new messages arrive, and the other device reads them.
  await post(readId, 4, body(4));
  await post(readId, 5, body(5));
  await elsewhere.run("open", `${proxy.origin}${workspacePath}/channel/${readId}`);
  await elsewhere.until(visible(body(5)), 60_000);
  await readThrough(5);

  // Opening the channel here, from memory, draws no divider over what the other device read.
  await here.run("eval", clickChannel(readId));
  await here.until(`${visible(body(5))} && ${openReadLanded(readId)}`);
  expect(await here.evaluate<boolean>(dividerShown)).toBe(false);
  await here.run("screenshot", join(artifacts, "opened-from-memory.png"));

  // Nor does a new page load, which opens it from storage.
  await here.run("open", `${proxy.origin}${workspacePath}/channel/${readId}`);
  await here.until(`${visible(body(5))} && ${openReadLanded(readId)}`, 60_000);
  expect(await here.evaluate<boolean>(dividerShown)).toBe(false);
  await here.run("screenshot", join(artifacts, "opened-from-storage.png"));
}, 300_000);

test("a channel the pointer rested on, then read on another device, opens here without a divider", async () => {
  // This device loads afresh on another channel (the router keeps no match of the read one); two
  // messages come, and the pointer rests on the channel's link, so the router reads its open ahead
  // (`defaultPreload: "intent"`), first unread and all.
  // The other device, left on the read channel, must not read the new messages before the rest.
  await elsewhere.run("open", "about:blank");
  await here.run("open", `${proxy.origin}${workspacePath}/channel/${otherId}`);
  await here.until(visible(otherBody), 60_000);
  await post(readId, 6, body(6));
  await post(readId, 7, body(7));
  await here.run("hover", `a[href*="/channel/${readId}"]`);
  const rested = Date.now();
  await here.until(openReadLanded(readId));
  const preloaded = await here.evaluate<number>(`${openReadState(readId)}.dataUpdatedAt`);

  // The other device reads them; this one hears it (`channel.marked.v1`), and the read kept from
  // the pointer's rest no longer stands (`markOpenReadStale`).
  await elsewhere.run("open", `${proxy.origin}${workspacePath}/channel/${readId}`);
  await elsewhere.until(visible(body(7)), 60_000);
  await readThrough(7);
  await here.until(`(${openReadState(readId)} ?? { isInvalidated: true }).isInvalidated`);

  // A click within the preload's lifetime opens on it, but takes no stale read: it reads afresh,
  // and shows no divider.
  // Past the router's preload reuse (`PRELOAD_STALE_MS`, 30s) the click would read afresh anyway,
  // and the case would pass without what it checks.
  expect(Date.now() - rested).toBeLessThan(25_000);
  await here.run("eval", clickChannel(readId));
  await here.until(
    `${visible(body(7))} && (${openReadState(readId)}?.dataUpdatedAt ?? 0) > ${preloaded}`,
  );
  expect(await here.evaluate<boolean>(dividerShown)).toBe(false);
  await here.run("screenshot", join(artifacts, "opened-after-preload.png"));
}, 300_000);
