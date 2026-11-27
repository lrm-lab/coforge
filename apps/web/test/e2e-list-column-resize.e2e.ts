import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { pageHydrated } from "./helpers/browser-e2e";

/**
 * The list beside an open conversation on Activity (and Search, which shares its width) can be
 * resized. It starts at 380px; a drag on its right-edge handle sets any width from 288 to 640,
 * at most half the page, and keeps it apart from the Chat list's width; double-click resets it,
 * the keys step it, and a reload keeps it.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`) + `agent-browser`
 * against the dev database, whose seeded Activity has a card to open. It creates nothing and
 * clears the preference keys it sets. Screenshots are written under `.artifacts/e2e/list-column-resize/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/list-column-resize");

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
  const HANDLE = '[role="separator"][aria-label="Resize list"]';
  const waitForWidth = (width: number) =>
    waitFor(
      `Math.abs(document.querySelector('${LIST}').getBoundingClientRect().width - ${width}) <= 2`,
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
      orderBy: { createdAt: "asc" },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${membership.workspace.slug}`;
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    await browser("open", `${origin}${workspacePath}/activity`);
    await browser(
      "eval",
      `localStorage.removeItem("coforge-list-column-width"); localStorage.setItem("coforge-conversation-list-width", "18.75")`,
    );
    await browser("reload");
    await waitFor(
      `document.querySelector('[data-activity-list] ol a') !== null && ${pageHydrated}`,
    );
    expect(await evaluate<number>(`document.querySelectorAll('${HANDLE}').length`)).toBe(1);
    await waitForWidth(380);
    await browser("click", "[data-activity-list] ol a");
    await waitForWidth(380);
    await browser("screenshot", join(artifacts, "default.png"));

    await dragListTo(500);
    await waitForWidth(500);
    expect(Number(await stored("coforge-list-column-width"))).toBeCloseTo(31.25, 1);
    expect(await stored("coforge-conversation-list-width")).toBe("18.75");
    await dragListTo(40);
    await waitForWidth(288);
    expect(Number(await stored("coforge-list-column-width"))).toBeCloseTo(18, 1);

    const panelsSharedWidthExcludingSeparator = await evaluate<number>(
      `(() => {
        const group = document.querySelector('${LIST}').closest('[data-group]');
        return Array.from(group.children)
          .filter((child) => child.hasAttribute("data-panel"))
          .reduce((sum, child) => sum + child.getBoundingClientRect().width, 0);
      })()`,
    );
    const half = panelsSharedWidthExcludingSeparator / 2;
    expect(half).toBeLessThan(640);
    await dragListTo(900);
    await waitForWidth(half);
    expect(Number(await stored("coforge-list-column-width"))).toBeCloseTo(half / 16, 1);
    await browser("screenshot", join(artifacts, "widest.png"));
    await browser("focus", HANDLE);
    await browser("press", "ArrowRight");
    await waitForWidth(half);
    await dragListTo(half - 100);
    await waitForWidth(half - 100);

    await browser("dblclick", HANDLE);
    await waitForWidth(380);
    expect(await stored("coforge-list-column-width")).toBe("23.75");
    await browser("focus", HANDLE);
    await browser("press", "ArrowRight");
    await waitFor(`document.querySelector('${LIST}').getBoundingClientRect().width > 380`);
    await browser("press", "Home");
    await waitForWidth(288);

    await browser("reload");
    await waitFor(`document.querySelector('${HANDLE}') !== null && ${pageHydrated}`);
    await waitForWidth(288);
    expect(
      Number.parseFloat(
        await evaluate<string>(
          `document.documentElement.style.getPropertyValue("--list-column-width")`,
        ),
      ),
    ).toBeCloseTo(18, 1);
  } finally {
    await browser(
      "eval",
      `localStorage.removeItem("coforge-list-column-width"); localStorage.removeItem("coforge-conversation-list-width")`,
    ).catch(() => undefined);
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);
