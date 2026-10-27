import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * The Chat page's conversation list column can be resized and collapsed. It starts at 288px; a
 * drag on its right-edge handle sets any width from 200 to 400 and keeps it; dragging far under
 * 200 collapses the list, and the expand button in the conversation's header brings it back;
 * double-click resets the width, the arrow keys, Home and End step it, a reload keeps it, and
 * Cmd/Ctrl+\ toggles the list even while typing in the composer.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`) + `agent-browser`
 * against the dev database. It creates nothing and clears the two preference keys it sets.
 * Screenshots are written under `.amp/e2e/conversation-list-resize/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/conversation-list-resize");

test("the conversation list resizes, collapses, and remembers both", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `conversation-list-resize-${process.pid}`;
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
            `location.pathname + location.search + " | " + document.querySelector("main")?.innerText.slice(0, 600)`,
          )
            .catch((error: unknown) => String(error))
            .then((page) =>
              reject(new Error(`Timed out waiting for: ${condition}\nPage: ${page}`)),
            );
        }, 15_000);
      }),
    ]);
  };

  const LIST = "main > section";
  const HANDLE = '[role="separator"][aria-orientation="vertical"]';
  const EXPAND = 'main button[aria-label="Expand conversation list"]';
  /** Waits for the list column's rendered width: 0 while it is hidden. */
  const waitForWidth = (width: number) =>
    waitFor(
      `Math.round(document.querySelector('${LIST}').getBoundingClientRect().width) === ${width}`,
    );
  const stored = (key: string) => evaluate<string | null>(`localStorage.getItem("${key}")`);
  const handleCentre = () =>
    evaluate<[number, number]>(
      `(() => { const box = document.querySelector('${HANDLE}').getBoundingClientRect(); return [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)]; })()`,
    );
  /** Drags the handle with a real pointer, in a few steps, by as much as takes the list to `width`
   * (narrower than the minimum asks for that much less). */
  async function dragListTo(width: number) {
    const [fromX, fromY] = await handleCentre();
    const shown = await evaluate<number>(
      `document.querySelector('${LIST}').getBoundingClientRect().width`,
    );
    const x = fromX + width - shown;
    await browser("mouse", "move", String(fromX), String(fromY));
    await browser("mouse", "down");
    for (let step = 1; step <= 5; step += 1)
      await browser(
        "mouse",
        "move",
        String(Math.round(fromX + ((x - fromX) * step) / 5)),
        String(fromY),
      );
    await browser("mouse", "up");
  }

  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${membership.workspace.slug}`;
    // Any channel the viewer is in, to have a composer to type in.
    const { conversationId: channelId } = await db.conversationMember.findFirstOrThrow({
      where: {
        userId: DEV_BROWSER_USER.id,
        workspaceId: membership.workspaceId,
        leftAt: null,
        conversation: { channelName: { not: null } },
      },
      select: { conversationId: true },
    });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    // A clean device: the list is 288px wide and shown.
    await browser("open", `${origin}${workspacePath}`);
    await browser(
      "eval",
      `localStorage.removeItem("coforge-conversation-list-width"); localStorage.removeItem("coforge-conversation-list-visible")`,
    );
    await browser("reload");
    await waitFor(`document.querySelector('${HANDLE}') !== null`);
    await waitForWidth(288);
    expect(
      await evaluate<string | null>(
        `document.querySelector('${HANDLE}').getAttribute("aria-valuenow")`,
      ),
    ).toBe("288");
    await browser("screenshot", join(artifacts, "default.png"));

    // Dragging far past the minimum collapses the list; the expand button brings it back.
    await dragListTo(40);
    await waitForWidth(0);
    expect(await stored("coforge-conversation-list-visible")).toBe("hide");
    await browser("screenshot", join(artifacts, "collapsed.png"));
    await waitFor(`document.querySelector('${EXPAND}')?.getBoundingClientRect().width > 0`);
    await browser("click", EXPAND);
    await waitForWidth(288);
    expect(await stored("coforge-conversation-list-visible")).toBe("show");
    await browser("screenshot", join(artifacts, "expanded.png"));

    // Dragging to the narrowest stops at 200, and a width in between follows the pointer.
    await dragListTo(330);
    await waitForWidth(330);
    await dragListTo(190);
    await waitForWidth(200);
    expect(await stored("coforge-conversation-list-width")).toBe("200");
    await browser("screenshot", join(artifacts, "narrowest.png"));

    // Double-click resets the width.
    await browser("dblclick", HANDLE);
    await waitForWidth(288);
    expect(await stored("coforge-conversation-list-width")).toBe("288");

    // The keyboard: the arrows step by 16, End goes to the maximum.
    await browser("focus", HANDLE);
    await browser("press", "ArrowRight");
    await waitForWidth(304);
    await browser("press", "End");
    await waitForWidth(400);
    expect(await stored("coforge-conversation-list-width")).toBe("400");

    // A reload keeps the width, and the first paint already has it.
    await browser("reload");
    await waitFor(`document.querySelector('${HANDLE}') !== null`);
    await waitForWidth(400);

    // Cmd/Ctrl+\ toggles the list, even with the caret in the composer.
    const apple = await evaluate<boolean>(`/Mac|iPhone|iPad/i.test(navigator.platform)`);
    const shortcut = `${apple ? "Meta" : "Control"}+\\`;
    await browser("open", `${origin}${workspacePath}/channel/${channelId}`);
    await waitFor(`document.querySelector('main textarea:not([disabled])') !== null`);
    await browser("focus", "main textarea");
    await browser("press", shortcut);
    await waitForWidth(0);
    expect(await evaluate<boolean>(`document.activeElement?.tagName === "TEXTAREA"`)).toBe(true);
    await browser("press", shortcut);
    await waitForWidth(400);
  } finally {
    await browser(
      "eval",
      `localStorage.removeItem("coforge-conversation-list-width"); localStorage.removeItem("coforge-conversation-list-visible")`,
    ).catch(() => undefined);
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);
