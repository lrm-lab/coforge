import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * The list beside an open conversation on Activity (and Search, which shares its width) can be
 * resized. It starts at 380px; a drag on its right-edge handle sets any width from 240 to 640,
 * at most half the page, and keeps it apart from the Chat list's width; double-click resets it,
 * the keys step it, and a reload keeps it.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`) + `agent-browser`
 * against the dev database, whose seeded Activity has a card to open. It creates nothing and
 * clears the preference keys it sets. Screenshots are written under `.amp/e2e/list-column-resize/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/list-column-resize");

test("the Activity list resizes beside the open conversation and keeps its own width", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `list-column-resize-${process.pid}`;
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

  const LIST = "[data-activity-list]";
  const HANDLE = '[data-activity-list] > [role="separator"]';
  /** Waits for the list column's rendered width. */
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
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    // A clean device, Chat's list set to its own width: the Activity list beside an open
    // conversation starts at 380px.
    await browser("open", `${origin}${workspacePath}/activity`);
    await browser(
      "eval",
      `localStorage.removeItem("coforge-list-column-width"); localStorage.setItem("coforge-conversation-list-width", "300")`,
    );
    await browser("reload");
    await waitFor(`document.querySelector('[data-activity-list] ol a') !== null`);
    expect(await evaluate<number>(`document.querySelectorAll('${HANDLE}').length`)).toBe(0);
    await browser("click", "[data-activity-list] ol a");
    await waitFor(`document.querySelector('${HANDLE}') !== null`);
    await waitForWidth(380);
    await browser("screenshot", join(artifacts, "default.png"));

    // A drag sets the width and keeps it; Chat's width is its own.
    await dragListTo(500);
    await waitForWidth(500);
    expect(await stored("coforge-list-column-width")).toBe("500");
    expect(await stored("coforge-conversation-list-width")).toBe("300");
    await dragListTo(40);
    await waitForWidth(240);
    expect(await stored("coforge-list-column-width")).toBe("240");

    // Past half the page the conversation keeps its half: the list stops at it, and the next drag
    // starts from the edge that is seen.
    const half = await evaluate<number>(
      `Math.round(document.querySelector('${LIST}').parentElement.getBoundingClientRect().width / 2)`,
    );
    expect(half).toBeLessThan(640);
    await dragListTo(900);
    await waitForWidth(half);
    expect(await stored("coforge-list-column-width")).toBe("640");
    await browser("screenshot", join(artifacts, "widest.png"));
    // Widening a list held at half the page keeps what is kept.
    await browser("focus", HANDLE);
    await browser("press", "ArrowRight");
    await waitForWidth(half);
    expect(await stored("coforge-list-column-width")).toBe("640");
    await dragListTo(half - 100);
    await waitForWidth(half - 100);

    // Double-click resets the width; the keyboard steps it.
    await browser("dblclick", HANDLE);
    await waitForWidth(380);
    expect(await stored("coforge-list-column-width")).toBe("380");
    await browser("focus", HANDLE);
    await browser("press", "ArrowRight");
    await waitForWidth(396);
    await browser("press", "Home");
    await waitForWidth(240);

    // A reload keeps the width, and the first paint already has it.
    await browser("reload");
    await waitFor(`document.querySelector('${HANDLE}') !== null`);
    await waitForWidth(240);
    expect(
      await evaluate<string>(
        `document.documentElement.style.getPropertyValue("--list-column-width")`,
      ),
    ).toBe("240px");
  } finally {
    await browser(
      "eval",
      `localStorage.removeItem("coforge-list-column-width"); localStorage.removeItem("coforge-conversation-list-width")`,
    ).catch(() => undefined);
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);
