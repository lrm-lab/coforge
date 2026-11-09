import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * Search as a dialog over the current page: Cmd/Ctrl+K, the rail's Search and a channel's "Search
 * this channel" open it without leaving the page; focus starts in the box, Up and Down walk the
 * results, Enter opens one (a message lands on it, however old), Esc closes and returns focus. An
 * old search address opens the dialog with its search.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser` (Chromium on macOS, so the
 * shortcut is Meta+K). Seeds are deterministic and reset on every run. Screenshots are written
 * under `.amp/e2e/search-shortcut/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/search-shortcut");

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

test("search opens over the page, walks by keyboard and lands on the message", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `search-shortcut-${process.pid}`;
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
  /** Waits for a page condition, failing with the condition and the page text after 15 s. */
  const waitFor = (condition: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      browser("wait", "--fn", condition).finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void browser(
            "eval",
            `location.pathname + location.search + " | " + document.querySelector("main")?.innerText`,
          )
            .catch((error: unknown) => String(error))
            .then((page) =>
              reject(new Error(`Timed out waiting for: ${condition}\nPage: ${page}`)),
            );
        }, 15_000);
      }),
    ]);
  };
  const dialog = `document.querySelector('[role="dialog"]')`;
  const box = `document.querySelector('[role="dialog"] input[type="search"]')`;
  /** Lets the dialog that just closed finish handing focus back, which it does a frame later. */
  const settled = () =>
    browser("eval", "new Promise((done) => setTimeout(done, 100))");
  const options = `[...document.querySelectorAll('[role="dialog"] [data-search-option]')]`;
  const hits = `document.querySelectorAll('[role="dialog"] ol li').length`;

  const channelA = seededUuid("e2e-search-shortcut:channel-a");
  const channelB = seededUuid("e2e-search-shortcut:channel-b");
  const phrase = "快捷样本";
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${membership.workspace.slug}`;
    const workspaceId = membership.workspaceId;
    await db.conversation.deleteMany({ where: { id: { in: [channelA, channelB] } } });
    await db.conversation.deleteMany({
      where: { workspaceId, channelName: { in: ["e2e-shortcut-a", "e2e-shortcut-b"] } },
    });
    await db.conversation.createMany({
      data: [
        { id: channelA, workspaceId, channelName: "e2e-shortcut-a", description: "" },
        { id: channelB, workspaceId, channelName: "e2e-shortcut-b", description: "" },
      ],
    });
    const memberA = await db.conversationMember.create({
      data: { conversationId: channelA, workspaceId, userId: DEV_BROWSER_USER.id },
    });
    const memberB = await db.conversationMember.create({
      data: { conversationId: channelB, workspaceId, userId: DEV_BROWSER_USER.id },
    });
    const inA = await db.message.create({
      data: {
        conversationId: channelA,
        workspaceId,
        senderMemberId: memberA.id,
        body: `${phrase} in a`,
        sequence: 1,
      },
    });
    await db.message.create({
      data: {
        conversationId: channelB,
        workspaceId,
        senderMemberId: memberB.id,
        body: `${phrase} in b`,
        sequence: 1,
      },
    });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    // Many later messages, so the oldest is far outside what a channel opens on.
    const oldWord = "最早样本";
    const old = await db.message.create({
      data: {
        conversationId: channelB,
        workspaceId,
        senderMemberId: memberB.id,
        body: oldWord,
        sequence: 2,
      },
    });
    await db.message.createMany({
      data: Array.from({ length: 400 }, (_, index) => ({
        conversationId: channelB,
        workspaceId,
        senderMemberId: memberB.id,
        body: `filler ${index}`,
        sequence: index + 3,
      })),
    });
    const channelPath = `${workspacePath}/channel/${channelA}`;
    const onChannelA = `[...document.querySelectorAll("h1")].some((h) => h.textContent === "#e2e-shortcut-a")`;

    await browser("open", `${origin}${channelPath}`);
    await waitFor(onChannelA);
    await browser("eval", "localStorage.clear()");

    // The shortcut opens over the page, focus in the box; the page's address does not change.
    await browser("press", "Meta+k");
    await waitFor(`${box} !== null && document.activeElement === ${box}`);
    expect(await evaluate<string>("location.pathname")).toBe(channelPath);
    await browser("screenshot", join(artifacts, "open.png"));

    // Typing searches. Down walks the results with real focus, Up returns to the box.
    await browser("fill", 'input[type="search"]', phrase);
    await waitFor(`${hits} === 2`);
    await browser("screenshot", join(artifacts, "results.png"));
    await browser("press", "ArrowDown");
    await waitFor(`document.activeElement === ${options}[1]`);
    await browser("press", "ArrowUp");
    await waitFor(`document.activeElement === ${options}[0]`);
    await browser("press", "ArrowUp");
    await waitFor(`document.activeElement === ${box}`);

    // The shortcut while open puts the caret back with the text selected.
    await browser("eval", `${box}.blur()`);
    await browser("press", "Meta+k");
    await waitFor(
      `document.activeElement === ${box} && ${box}.selectionStart === 0 && ${box}.selectionEnd === ${phrase.length}`,
    );

    await browser("press", "Escape");
    await waitFor(`${dialog} === null`);

    // Esc closes and hands focus back to where it was.
    await settled();
    await browser("eval", `document.querySelector('[aria-label="Search this channel"]').focus()`);
    await browser("press", "Meta+k");
    await waitFor(`${box} !== null && document.activeElement === ${box}`);
    await browser("press", "Escape");
    await waitFor(
      `${dialog} === null && document.activeElement === document.querySelector('[aria-label="Search this channel"]')`,
    );

    // A channel's "Search this channel" limits search to it and waits for a query.
    await browser("click", '[aria-label="Search this channel"]');
    await waitFor(
      `[...document.querySelectorAll('[aria-label="Search filters"] button')].some((button) => button.textContent.includes("e2e-shortcut-a"))`,
    );
    expect(await evaluate<number>(hits)).toBe(0);
    await browser("fill", 'input[type="search"]', phrase);
    await waitFor(`${hits} === 1`);
    expect(
      await evaluate<string>(
        `document.querySelector("[data-search-message-id]").dataset.searchMessageId`,
      ),
    ).toBe(inA.id);
    await browser("press", "Escape");
    await waitFor(`${dialog} === null`);

    // The rail's Search opens the dialog fresh, staying on the page.
    await browser("click", `aside a[href="${workspacePath}/search"]`);
    await waitFor(`${box} !== null && ${box}.value === ""`);
    expect(await evaluate<string>("location.pathname")).toBe(channelPath);
    await browser("press", "Escape");
    await waitFor(`${dialog} === null`);

    // Esc gives the focus back to what had it before the dialog opened.
    const rail = `document.querySelector('aside a[href="${workspacePath}/search"]')`;
    await settled();
    await browser("eval", `${rail}.focus()`);
    await browser("press", "Meta+k");
    await waitFor(`${box} !== null && document.activeElement === ${box}`);
    await browser("press", "Escape");
    await waitFor(`${dialog} === null && document.activeElement === ${rail}`);

    // The first row shows as chosen from the box, and stays so as the results change; Down from
    // the box goes to the row after it, Up back along the list and into the box.
    const firstIsMarked = `${options}[0]?.hasAttribute("data-search-first") === true`;
    await browser("press", "Meta+k");
    await waitFor(`document.activeElement === ${box}`);
    await browser("fill", 'input[type="search"]', phrase);
    await waitFor(`${hits} === 2 && ${firstIsMarked}`);
    await browser("fill", 'input[type="search"]', `${phrase} `);
    await browser("fill", 'input[type="search"]', oldWord);
    await waitFor(`${hits} === 1 && ${firstIsMarked}`);
    await browser("fill", 'input[type="search"]', phrase);
    await waitFor(`${hits} === 2 && ${firstIsMarked}`);
    await browser("press", "ArrowDown");
    await waitFor(`document.activeElement === ${options}[1]`);
    await browser("press", "ArrowUp");
    await waitFor(`document.activeElement === ${options}[0]`);
    await browser("press", "ArrowUp");
    await waitFor(`document.activeElement === ${box}`);
    await browser("press", "Escape");
    await waitFor(`${dialog} === null`);

    // An old address opens the dialog with its search, over the Workspace.
    await browser(
      "open",
      `${origin}${workspacePath}/search?q=${encodeURIComponent(phrase)}&range=7d`,
    );
    await waitFor(`${box}?.value === ${JSON.stringify(phrase)} && ${hits} === 2`);
    expect(await evaluate<string>("location.pathname")).not.toContain("/search");

    // Enter on a far older message closes search and lands on it, on screen.
    await browser("fill", 'input[type="search"]', oldWord);
    await waitFor(
      `${hits} === 1 && document.querySelector('[data-search-message-id="${old.id}"]') !== null`,
    );
    await waitFor(`document.activeElement === ${box}`);
    await browser("press", "ArrowDown");
    await browser("press", "ArrowUp");
    await browser("press", "Enter");
    await waitFor(`${dialog} === null && location.pathname.endsWith("/channel/${channelB}")`);
    await waitFor(
      `(() => { const row = document.getElementById("message-${old.id}"); if (!row) return false; const box = row.getBoundingClientRect(); const history = row.closest("[data-scroll-restoration-id]").getBoundingClientRect(); return box.top >= history.top && box.bottom <= history.bottom; })()`,
    );
    await browser("screenshot", join(artifacts, "landed.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channelA, channelB] } } })
      .catch(() => {});
    await db.$disconnect();
  }
}, 240_000);
