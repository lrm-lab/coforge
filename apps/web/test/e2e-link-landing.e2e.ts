import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * A pasted link lands where it points (task #34). A thread reply's link, opened in a new tab,
 * opens its thread scrolled to the reply and highlights it, as a click inside the app does. A
 * `?message=` short id that more than one message starts with says so instead of quietly
 * opening at the latest.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`; rows are seeded with
 * deterministic ids, so reruns restore them. Screenshots go to `.amp/e2e/link-landing/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/link-landing");

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
function seededUuid(key: string, prefix?: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  const head = prefix ?? hash.slice(0, 8);
  return `${head}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

test("a pasted reply link lands on the reply; a shared short id says so", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `link-landing-${process.pid}`;
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
  async function evaluate<T>(expression: string): Promise<T> {
    return JSON.parse(JSON.parse(await browser("eval", `JSON.stringify(${expression})`))) as T;
  }
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${membership.workspace.slug}`;
    const viewer = await db.conversationMember.findFirstOrThrow({
      where: {
        userId: DEV_BROWSER_USER.id,
        workspaceId: membership.workspaceId,
        leftAt: null,
        conversation: { channelName: { not: null }, archivedAt: null },
      },
      include: { conversation: true },
      orderBy: { conversation: { createdAt: "asc" } },
    });
    const channel = viewer.conversation;
    const last = await db.message.aggregate({
      where: { conversationId: channel.id },
      _max: { sequence: true },
    });
    let sequence = (last._max.sequence ?? 0) + 1;
    const rootId = seededUuid("e2e-link-landing:root");
    // Enough replies that the pane scrolls: the target, the 26th, starts below the first screen.
    const replyIds = Array.from({ length: 40 }, (_, at) => seededUuid(`e2e-link-landing:${at}`));
    const target = replyIds[25]!;
    // Two top-level messages sharing an eight-hex prefix, like #coforge's six `01a1b756…`.
    const sharedPrefix = "0e2e1a4d";
    const twins = [1, 2].map((n) => seededUuid(`e2e-link-landing:twin-${n}`, sharedPrefix));
    const rows = [
      ...twins.map((id, at) => ({ id, body: `Link landing twin ${at + 1}` })),
      { id: rootId, body: "Link landing root" },
      ...replyIds.map((id, at) => ({
        id,
        body: `Link landing reply ${at + 1}`,
        threadRootId: rootId,
      })),
    ];
    for (const row of rows) {
      await db.message.upsert({
        where: { id: row.id },
        update: { body: row.body, sequence },
        create: {
          ...row,
          senderMemberId: viewer.id,
          conversationId: channel.id,
          workspaceId: channel.workspaceId,
          sequence,
        },
      });
      sequence += 1;
    }
    await mkdir(artifacts, { recursive: true });
    const channelUrl = `${origin}${workspacePath}/channel/${channel.id}`;

    await browser("set", "viewport", "1440", "900");
    // A new tab, the whole link pasted: a notification's link names only the reply, a link from
    // an open thread names its root too. Either opens the thread on the reply, ringed.
    const replyLinks = {
      notification: `${channelUrl}?view=chat#message-${target}`,
      thread: `${channelUrl}?threadRootId=${rootId}#message-${target}`,
    };
    for (const [name, url] of Object.entries(replyLinks)) {
      await browser("open", url);
      await browser("wait", "--fn", `document.getElementById("message-${target}") !== null`);
      // Long enough for the open position and the router's scroll restoration to have had a go,
      // short of the ring's 2.5 s.
      await browser("wait", "800");
      const landed = await evaluate<{
        search: string;
        hash: string;
        inView: boolean;
        highlighted: boolean;
      }>(`(() => {
        const row = document.getElementById("message-${target}");
        const box = row.getBoundingClientRect();
        const history = row.closest("[data-scroll-restoration-id]").getBoundingClientRect();
        return {
          search: location.search,
          hash: location.hash,
          inView: box.top >= history.top && box.bottom <= history.bottom,
          // The landing ring (message-row.tsx) is a box-shadow, worn for a moment.
          highlighted: getComputedStyle(row).boxShadow !== "none",
        };
      })()`);
      await browser("screenshot", join(artifacts, `reply-link-${name}.png`));
      expect({ name, ...landed }).toEqual({
        name,
        search: expect.stringContaining(`threadRootId=${rootId}`),
        hash: `#message-${target}`,
        inView: true,
        highlighted: true,
      });
    }

    // A short id that two messages start with.
    await browser("open", `${channelUrl}?message=${sharedPrefix}`);
    await browser(
      "wait",
      "--fn",
      `document.body.textContent.includes("This link matches more than one message")`,
    );
    // It picks neither: no row wears the landing ring.
    expect(
      await evaluate<boolean>(
        `${JSON.stringify(twins)}.every((id) => getComputedStyle(document.getElementById("message-" + id)).boxShadow === "none")`,
      ),
    ).toBe(true);
    await browser("screenshot", join(artifacts, "shared-short-id.png"));

    // A short id only one message starts with lands on it, as its whole id does.
    await browser("open", `${channelUrl}?message=${rootId.slice(0, 8)}`);
    await browser(
      "wait",
      "--fn",
      `getComputedStyle(document.getElementById("message-${rootId}") ?? document.body).boxShadow !== "none"`,
    );
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
