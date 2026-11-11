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
      orderBy: { createdAt: "asc" },
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
    // Two older top-level messages, far above the latest (QA, staging: a link to one stayed
    // 1286px above the view): one inside the first page the channel loads, one beyond it.
    const oldFar = seededUuid("e2e-link-landing:old-far");
    const oldNear = seededUuid("e2e-link-landing:old-near");
    const fillers = (from: number, count: number) =>
      Array.from({ length: count }, (_, at) => ({
        id: seededUuid(`e2e-link-landing:filler-${from + at}`),
        body: `Link landing filler ${from + at + 1}`,
      }));
    const rows = [
      { id: oldFar, body: "Link landing old far" },
      ...fillers(0, 60),
      { id: oldNear, body: "Link landing old near" },
      ...fillers(60, 25),
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

    // The read of where the viewer's unread starts answers late, as on a slow network (QA,
    // staging): the link's landing must hold once it settles. The script is a launch init script
    // of the session, so it is carried by its first command.
    const slowOpen = join(artifacts, "slow-open-read.js");
    await Bun.write(
      slowOpen,
      `(() => {
        if (window.__slowOpen !== undefined) return;
        window.__slowOpen = 0;
        const fetch = window.fetch.bind(window);
        const isOpenRead = (input) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          // Server function ids are hashes; the open read is the one whose data is a conversation id
          // alone, or with a thread root.
          const payload = decodeURIComponent(url);
          return url.includes("_serverFn/") && /"k":\\["conversationId"(,"threadRootId")?\\]/.test(payload);
        };
        window.fetch = async (input, init) => {
          const response = await fetch(input, init);
          if (!isOpenRead(input)) return response;
          window.__slowOpen += 1;
          await new Promise((resolve) => setTimeout(resolve, 2500));
          return response;
        };
      })();`,
    );
    await browser("--init-script", slowOpen, "set", "viewport", "1440", "900");
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

    // A link to an older top-level message, in a fresh tab: loaded or not, the channel opens on
    // it, ringed, instead of at the latest.
    const oldLinks = [
      ["old-far-query", oldFar, `${channelUrl}?view=chat&message=${oldFar}`],
      ["old-near-query", oldNear, `${channelUrl}?view=chat&message=${oldNear}`],
      ["old-near", oldNear, `${channelUrl}?view=chat#message-${oldNear}`],
      ["old-far", oldFar, `${channelUrl}?view=chat#message-${oldFar}`],
    ] as const;
    for (const [name, id, link] of oldLinks) {
      const place = `(() => {
        const row = document.getElementById("message-${id}");
        const box = row.getBoundingClientRect();
        const history = row.closest("[data-scroll-restoration-id]").getBoundingClientRect();
        return {
          inView: box.top >= history.top && box.bottom <= history.bottom,
          highlighted: getComputedStyle(row).boxShadow !== "none",
        };
      })()`;
      await browser("open", link);
      await browser("wait", "--fn", `document.getElementById("message-${id}") !== null`);
      await browser("wait", "800");
      const landed = await evaluate<{ inView: boolean; highlighted: boolean }>(place);
      await browser("screenshot", join(artifacts, `${name}.png`));
      expect({ name, ...landed }).toEqual({ name, inView: true, highlighted: true });
      // It stays there once the late read has settled.
      await browser("wait", "3500");
      expect(await evaluate<number>("window.__slowOpen")).toBeGreaterThan(0);
      expect((await evaluate<{ inView: boolean }>(place)).inView).toBe(true);
    }

    // Grace's case (task #46): a channel's second message, with 400 newer ones written in one
    // statement after it, so the target sits at the very start of the channel's history.
    const earlyChannelId = seededUuid("e2e-link-landing:early-channel");
    await db.conversation.upsert({
      where: { id: earlyChannelId },
      update: { archivedAt: null },
      create: {
        id: earlyChannelId,
        workspaceId: channel.workspaceId,
        channelName: "e2e-link-landing-early",
      },
    });
    await db.message.deleteMany({ where: { conversationId: earlyChannelId } });
    const earlyViewer = await db.conversationMember.upsert({
      where: {
        conversationId_userId: { conversationId: earlyChannelId, userId: DEV_BROWSER_USER.id },
      },
      update: { leftAt: null, hiddenAt: null },
      create: {
        conversationId: earlyChannelId,
        workspaceId: channel.workspaceId,
        userId: DEV_BROWSER_USER.id,
      },
    });
    const earliest = seededUuid("e2e-link-landing:early-target");
    await db.message.createMany({
      data: [
        "Link landing early first",
        "Link landing early target",
        ...Array.from({ length: 400 }, (_, at) => `filler ${at + 1}`),
      ].map((body, at) => ({
        ...(at === 1 && { id: earliest }),
        body,
        sequence: at + 1,
        senderMemberId: earlyViewer.id,
        conversationId: earlyChannelId,
        workspaceId: channel.workspaceId,
      })),
    });
    const earlyUrl = `${origin}${workspacePath}/channel/${earlyChannelId}?view=chat`;
    for (const [name, link] of [
      ["early-query", `${earlyUrl}&message=${earliest}`],
      ["early-hash", `${earlyUrl}#message-${earliest}`],
    ] as const) {
      await browser("open", link);
      await browser("wait", "--fn", `document.getElementById("message-${earliest}") !== null`);
      // It stays there: newer pages loading below must not carry the reader away from it.
      await browser("wait", "3000");
      const box = await evaluate<{
        top: number;
        bottom: number;
        viewTop: number;
        viewBottom: number;
      }>(`(() => {
        const row = document.getElementById("message-${earliest}").getBoundingClientRect();
        const view = document.getElementById("message-${earliest}").closest("[data-scroll-restoration-id]").getBoundingClientRect();
        return { top: row.top, bottom: row.bottom, viewTop: view.top, viewBottom: view.bottom };
      })()`);
      await browser("screenshot", join(artifacts, `${name}.png`));
      expect({
        name,
        inView: box.top >= box.viewTop && box.bottom <= box.viewBottom,
        box,
      }).toMatchObject({
        name,
        inView: true,
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

    // On a phone the thread's ring is whole, with room to spare: it stays at least 2px clear of
    // the history's edge on both sides (task #37). The ring reaches as far as its widest
    // box-shadow spread.
    await browser("set", "viewport", "390", "844");
    await browser("open", replyLinks.notification);
    await browser(
      "wait",
      "--fn",
      // Every row wears a transparent shadow; the ring is the one with a spread.
      `/0px 0px 0px [1-9]/.test(getComputedStyle(document.getElementById("message-${target}") ?? document.body).boxShadow)`,
    );
    // Past the ring's 500 ms fade-in, inside its 2.5 s.
    await browser("wait", "700");
    const ring = await evaluate<{
      reach: number;
      left: number;
      right: number;
      viewLeft: number;
      viewRight: number;
    }>(`(() => {
      const row = document.getElementById("message-${target}");
      const spreads = [...getComputedStyle(row).boxShadow.matchAll(/(-?[\\d.]+)px (-?[\\d.]+)px (-?[\\d.]+)px (-?[\\d.]+)px/g)].map((m) => Number(m[4]));
      const reach = Math.max(0, ...spreads);
      const box = row.getBoundingClientRect();
      const view = row.closest("[data-scroll-restoration-id]").getBoundingClientRect();
      return { reach, left: box.left - reach, right: box.right + reach, viewLeft: view.left, viewRight: view.right };
    })()`);
    await browser("screenshot", join(artifacts, "reply-link-phone.png"));
    expect(ring.reach).toBeGreaterThan(0);
    expect(ring.left - ring.viewLeft).toBeGreaterThanOrEqual(2);
    expect(ring.viewRight - ring.right).toBeGreaterThanOrEqual(2);
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
