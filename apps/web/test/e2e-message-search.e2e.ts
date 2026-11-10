import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { pageHydrated } from "./helpers/browser-e2e";

/**
 * The search dialog in a real browser. The search bar at the top opens it over the page, empty;
 * typing a Chinese phrase lists the matching message with the phrase highlighted, including a
 * message in a channel the viewer never joined. Clicking a result closes the dialog and opens its
 * channel at that message. With no match the dialog says so and keeps the search box.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel is seeded
 * deterministically and reset on every run. Screenshots are written under
 * `.amp/e2e/message-search/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/message-search");

/** Deterministic id (seed-dev's sha256→UUID shape), so a rerun updates instead of duplicating. */
function seededUuid(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

test("the search dialog finds a message and opens it in its channel", async () => {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const session = `message-search-${process.pid}`;
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
  const waitFor = (condition: string) => browser("wait", "--fn", condition);
  const box = `document.querySelector('[role="dialog"] input[type="search"]')`;
  const byText = (selector: string, text: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find((element) => element.textContent.trim() === ${JSON.stringify(text)})`;

  const channelId = seededUuid("e2e-message-search:channel");
  const authorUserId = DEV_BROWSER_USER.id;
  const phrase = "验收暗号蓝鲸";
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${membership.workspace.slug}`;
    const workspaceId = membership.workspaceId;
    // Reset: a channel the viewer never joined, holding one match among older filler, so the
    // jump has to load the window around the match.
    await db.conversation.deleteMany({ where: { id: channelId } });
    await db.conversation.deleteMany({
      where: { workspaceId, channelName: "e2e-search" },
    });
    await db.conversation.create({
      data: {
        id: channelId,
        workspaceId,
        channelName: "e2e-search",
        description: "",
      },
    });
    // The author is a separate member row for the dev user who then leaves, so the viewer is
    // not an active member: search must still find channel messages.
    const author = await db.conversationMember.create({
      data: {
        conversationId: channelId,
        workspaceId,
        userId: authorUserId,
        leftAt: new Date(),
      },
    });
    const bodies = [
      ...Array.from({ length: 120 }, (_, index) => `filler message ${index + 1}`),
      `今天的${phrase}已经确认，可以发版`,
      ...Array.from({ length: 5 }, (_, index) => `later message ${index + 1}`),
    ];
    const start = Date.now() - bodies.length * 60_000;
    await db.message.createMany({
      data: bodies.map((body, index) => ({
        conversationId: channelId,
        workspaceId,
        senderMemberId: author.id,
        body,
        sequence: index + 1,
        createdAt: new Date(start + index * 60_000),
      })),
    });
    const match = await db.message.findFirstOrThrow({
      where: { conversationId: channelId, body: { contains: phrase } },
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}${workspacePath}`);
    await browser("eval", "localStorage.clear()");
    // The search bar at the top opens the empty dialog with the box focused; it is a button, so
    // only once the page has hydrated.
    await waitFor(pageHydrated);
    await browser("click", "[data-search-bar]");
    await waitFor(
      `document.querySelector('[role="dialog"]')?.textContent.includes("Search everything")`,
    );
    await waitFor(`document.activeElement === ${box}`);
    await browser("screenshot", join(artifacts, "empty.png"));

    // Typing lists the match with the phrase highlighted.
    await browser("fill", 'input[type="search"]', "蓝鲸");
    await waitFor(`document.querySelector('[role="dialog"] ol li mark') !== null`);
    const result = await evaluate<{
      marks: string[];
      text: string;
      count: string;
    }>(`(() => {
      const row = document.querySelector('[role="dialog"] ol li');
      return {
        marks: [...row.querySelectorAll("mark")].map((mark) => mark.textContent),
        text: row.textContent,
        count: document.querySelector('[role="dialog"] [role="status"]').textContent,
      };
    })()`);
    expect(result.marks).toEqual(["蓝鲸"]);
    expect(result.text).toContain("#e2e-search");
    expect(result.text).toContain(`今天的${phrase}已经确认`);
    expect(result.count).toBe("1 result");
    await browser("screenshot", join(artifacts, "results.png"));

    // The result closes the dialog and opens its channel at the message.
    await browser("click", '[role="dialog"] ol li a');
    await waitFor(
      `location.pathname === "${workspacePath}/channel/${channelId}" && document.querySelector('[role="dialog"]') === null`,
    );
    await waitFor(`document.querySelector('li[data-message-id="${match.id}"]') !== null`);
    await browser("screenshot", join(artifacts, "jumped.png"));

    // Search opens fresh from the bar; a query with no match keeps the box and says so.
    await browser("click", "[data-search-bar]");
    await waitFor(`${box} !== null && ${box}.value === ""`);
    await browser("fill", 'input[type="search"]', "不存在的暗号");
    await waitFor(
      `document.querySelector('[role="dialog"]').textContent.includes("No results for “不存在的暗号”")`,
    );
    await browser("screenshot", join(artifacts, "no-results.png"));

    // The no-results state offers to clear the search, which empties the box.
    await browser("eval", `${byText('[role="dialog"] button', "Clear search")}.click()`);
    await waitFor(`${box}.value === ""`);
    await waitFor(`document.activeElement === ${box}`);
    // An input method: nothing is searched while composing, and the text it produces is
    // searched once composition ends, even though its last input event came before that end.
    await browser(
      "eval",
      `(() => {
        const input = document.querySelector('[role="dialog"] input[type="search"]');
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        for (const value of ["l", "la", "lan", "蓝鲸"]) {
          setValue.call(input, value);
          input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, data: value }));
        }
        window.__composingSince = Date.now();
      })()`,
    );
    // Well past the commit delay, the dialog still waits for the composition to end.
    await waitFor(`Date.now() - window.__composingSince > 600`);
    expect(
      await evaluate<boolean>(
        `document.querySelector('[role="dialog"] [aria-label="Search filters"]') !== null || document.querySelector('[role="dialog"] ol li') !== null`,
      ),
    ).toBe(false);
    await browser(
      "eval",
      `${box}.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "蓝鲸" }))`,
    );
    await waitFor(`document.querySelector('[role="dialog"] ol li mark')?.textContent === "蓝鲸"`);
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channelId } }).catch(() => {});
    await db.$disconnect();
  }
}, 120_000);
