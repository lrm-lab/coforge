import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * The search dialog keeps its scrolling inside its own list: the document never grows past the
 * viewport, neither on the empty dialog with a long Frequently used list on a phone, nor on a
 * search whose matches include an Agent on a short window.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user in a
 * Workspace with at least four Agents and six channels, one Agent named Atlas (seed-dev).
 * Frequently used is browser-local, so the test writes it into this session's storage. Each
 * viewport is short enough that the list overflows its scroll box, which the test checks first.
 * Screenshots are written under `.artifacts/e2e/search-overflow/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/search-overflow");

test("search never scrolls the document, empty or with results", async () => {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const session = `search-overflow-${process.pid}`;
  async function browser(...args: string[]) {
    const child = Bun.spawn([browserPath!, "--session", session, ...args], {
      env: { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: "30000" },
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
  /** The Agent rows' list overflows its own scroll box (so the check means something); the
   * document does not. */
  async function expectOnlyTheListScrolls() {
    const overflow = JSON.parse(
      await browser(
        "eval",
        `(() => {
          let list = document.querySelector('[role="dialog"] [data-search-entity^="agent:"]');
          while (list && getComputedStyle(list).overflowY !== "auto") list = list.parentElement;
          return {
            document: document.documentElement.scrollHeight - document.documentElement.clientHeight,
            list: list ? list.scrollHeight - list.clientHeight : -1,
          };
        })()`,
      ),
    ) as { document: number; list: number };
    expect(overflow.list).toBeGreaterThan(0);
    expect(overflow.document).toBeLessThanOrEqual(0);
  }

  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      // Other e2es leave the dev user in Workspaces of their own; the seed made the first one.
      orderBy: { workspace: { createdAt: "asc" } },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${membership.workspace.slug}`;
    const { workspaceId } = membership;
    const [channels, agents] = await Promise.all([
      db.conversation.findMany({
        where: { workspaceId, channelName: { not: null }, archivedAt: null },
        orderBy: { createdAt: "asc" },
        take: 6,
        select: { id: true },
      }),
      db.agent.findMany({
        // Agents the dev user can see: public ones and its own private ones.
        where: {
          workspaceId,
          deletedAt: null,
          OR: [{ visibility: "public" }, { ownerId: DEV_BROWSER_USER.id }],
        },
        orderBy: { createdAt: "asc" },
        take: 4,
        select: { id: true },
      }),
    ]);
    // Channels opened more often rank first, so the Agent cards (and their hidden status text)
    // are the bottom of the list.
    const now = Date.now();
    const usage = Object.fromEntries([
      ...channels.map(({ id }) => [`channel:${id}`, [now, now - 1_000, now - 2_000]]),
      ...agents.map(({ id }) => [`agent:${id}`, [now - 5_000]]),
    ]);
    const storageScope = `${workspaceId}:${DEV_BROWSER_USER.id}`;

    await browser("set", "viewport", "390", "300");
    await browser("open", `${origin}${workspacePath}/search`);
    await browser(
      "eval",
      `localStorage.setItem(${JSON.stringify(`coforge:search-usage:${storageScope}`)}, ${JSON.stringify(JSON.stringify(usage))})`,
    );
    await browser("open", `${origin}${workspacePath}/search`);
    await browser(
      "wait",
      "--fn",
      `document.querySelectorAll('[role="dialog"] [aria-labelledby="search-frequent-heading"] [data-search-entity^="agent:"]').length === ${agents.length}`,
    );
    // On a phone SearchDialog uses <ModalOverlay page> (task #320233252) with document-level
    // vertical scrolling and a sticky header; verify no horizontal overflow, non-overlapping header
    // controls above the list, and scrolling the document reaches the last Agent row cleanly.
    const phoneInitial = JSON.parse(
      await browser(
        "eval",
        `(() => {
          const dialog = document.querySelector('[role="dialog"]');
          const pageFlow = document.querySelector('[data-phone-page-flow]');
          const input = dialog?.querySelector('input[type="search"]');
          const close = dialog?.querySelector('button[aria-label="Close"]');
          const firstOption = dialog?.querySelector('[data-search-option]');
          if (!dialog || !pageFlow || !input || !close || !firstOption) return null;
          const d = dialog.getBoundingClientRect();
          const i = input.getBoundingClientRect();
          const c = close.getBoundingClientRect();
          const f = firstOption.getBoundingClientRect();
          return {
            docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            docScrollY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
            dialogWidth: Math.round(d.width),
            innerWidth,
            inputInBounds: i.left >= 0 && i.right <= c.left && c.right <= innerWidth && c.width > 0,
            headerAboveFirstOption: Math.max(i.bottom, c.bottom) <= f.top,
          };
        })()`,
      ),
    ) as {
      docOverflowX: number;
      docScrollY: number;
      dialogWidth: number;
      innerWidth: number;
      inputInBounds: boolean;
      headerAboveFirstOption: boolean;
    } | null;
    expect(phoneInitial).not.toBeNull();
    expect(phoneInitial!.docOverflowX).toBeLessThanOrEqual(0);
    expect(phoneInitial!.docScrollY).toBeGreaterThan(0);
    expect(phoneInitial!.dialogWidth).toBe(phoneInitial!.innerWidth);
    expect(phoneInitial!.inputInBounds).toBe(true);
    expect(phoneInitial!.headerAboveFirstOption).toBe(true);
    await browser(
      "eval",
      `(() => { const rows = [...document.querySelectorAll('[role="dialog"] [data-search-entity^="agent:"]')]; rows.at(-1)?.scrollIntoView({ block: "end" }); return true; })()`,
    );
    const phoneScrolled = JSON.parse(
      await browser(
        "eval",
        `(() => {
          const last = [...document.querySelectorAll('[role="dialog"] [data-search-entity^="agent:"]')].at(-1);
          const rect = last?.getBoundingClientRect();
          return {
            scrollY: window.scrollY,
            docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            lastInView: Boolean(rect && rect.top >= 0 && rect.bottom <= window.innerHeight + 1),
          };
        })()`,
      ),
    ) as { scrollY: number; docOverflowX: number; lastInView: boolean };
    expect(phoneScrolled.scrollY).toBeGreaterThan(0);
    expect(phoneScrolled.docOverflowX).toBeLessThanOrEqual(0);
    expect(phoneScrolled.lastInView).toBe(true);
    await mkdir(artifacts, { recursive: true });
    await browser("screenshot", join(artifacts, "search-home-phone.png"));

    await browser("set", "viewport", "1280", "200");
    await browser("open", `${origin}${workspacePath}/search?q=atlas`);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"] [data-search-entity^="agent:"]') !== null`,
    );
    await expectOnlyTheListScrolls();
    await browser("screenshot", join(artifacts, "search-results-short.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
