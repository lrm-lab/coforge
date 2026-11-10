import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  browserSession,
  hydratedElement,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

/**
 * The desktop sidebar can be resized (task #73). It starts at 192px (12rem); a drag on its
 * right-edge handle sets any width up to 320 and the top bar's zone above it follows, so a long
 * Workspace name that was cut short shows whole. The width is kept across a reload, a drag past
 * either end stops at 192 or 320, double-click goes back to the default and the arrow keys step it
 * by 16.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`) + `agent-browser`.
 * It seeds a Workspace with a short but still too long name for the default width, removes it
 * afterwards and clears the preference key it sets. Screenshots are written under
 * `.amp/e2e/sidebar-resize/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/sidebar-resize");

const KEY = "coforge-sidebar-width";
const HANDLE = '[role="separator"][aria-label="Resize sidebar"]';
/** The sidebar column the handle sits in, and the top bar's zone above it that shares its width. */
const SIDEBAR = `document.querySelector('${HANDLE}').parentElement`;
const TOP_ZONE = `document.querySelector("header [data-workspace-name]").closest("header").firstElementChild.firstElementChild`;
const NAME = `${TOP_ZONE}.querySelector("[data-workspace-name]")`;

test("the sidebar resizes, keeps its width and clamps between 192 and 320", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(
    browserPath,
    `sidebar-resize-${process.pid}`,
  );
  const width = (element: string) =>
    evaluate<number>(`Math.round(${element}.getBoundingClientRect().width)`);
  const waitForWidth = (value: number) =>
    waitFor(
      `Math.round(${SIDEBAR}.getBoundingClientRect().width) === ${value} && Math.round(${TOP_ZONE}.getBoundingClientRect().width) === ${value}`,
    );
  const stored = () => evaluate<string | null>(`localStorage.getItem("${KEY}")`);
  /** The workspace name's text is cut short when what it holds is wider than its box. */
  const nameCut = () => evaluate<boolean>(`${NAME}.scrollWidth > ${NAME}.clientWidth`);
  const handleCentre = () =>
    evaluate<[number, number]>(
      `(() => { const box = document.querySelector('${HANDLE}').getBoundingClientRect(); return [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)]; })()`,
    );
  /** Drags the handle with a real pointer, in a few steps, `by` pixels to the right. */
  async function dragBy(by: number) {
    const [fromX, fromY] = await handleCentre();
    await browser("mouse", "move", String(fromX), String(fromY));
    await browser("mouse", "down");
    for (let step = 1; step <= 5; step += 1)
      await browser("mouse", "move", String(Math.round(fromX + (by * step) / 5)), String(fromY));
    await browser("mouse", "up");
  }
  /** The page is ready for the pointer: hydrated, with the handle's listeners attached. */
  const ready = () =>
    waitFor(
      `${pageHydrated} && document.querySelector('${HANDLE}') !== null && ${hydratedElement(`document.querySelector('${HANDLE}')`)} && document.querySelector("header [data-workspace-name]") !== null`,
    );

  await db.user.upsert({
    where: { id: DEV_BROWSER_USER.id },
    update: {},
    create: {
      id: DEV_BROWSER_USER.id,
      username: DEV_BROWSER_USER.username,
      displayName: "Sidebar reviewer",
      welcomedAt: new Date(),
    },
  });
  const workspace = await db.workspace.create({
    data: {
      // Wider than the 192px sidebar's room for it, narrower than the 296px one's.
      name: "Platform Studio",
      slug: `sidebar-resize-${process.pid}`,
      members: { create: { userId: DEV_BROWSER_USER.id, role: "owner" } },
    },
  });
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "800");

    // A clean device: the sidebar is 192px wide and the name is cut short.
    await browser("open", `${origin}/en/w/${workspace.slug}`);
    await ready();
    await browser("eval", `localStorage.removeItem("${KEY}")`);
    await browser("reload");
    await ready();
    await waitForWidth(192);
    expect(await nameCut()).toBe(true);
    expect(
      await evaluate<string | null>(
        `document.querySelector('${HANDLE}').getAttribute("aria-valuenow")`,
      ),
    ).toBe("192");
    await browser("screenshot", join(artifacts, "default.png"));

    // A drag to the right widens the sidebar and the top bar's zone with it, by as much as the
    // pointer moved; the name shows whole.
    await dragBy(104);
    await waitForWidth(296);
    expect(await stored()).toBe("296");
    expect(
      await evaluate<string>(`document.documentElement.style.getPropertyValue("--sidebar-width")`),
    ).toBe("296px");
    await waitFor(`${NAME}.scrollWidth <= ${NAME}.clientWidth`);
    expect(await nameCut()).toBe(false);
    await browser("screenshot", join(artifacts, "wider.png"));

    // A reload keeps the width, and the name is whole from the first paint.
    await browser("reload");
    await ready();
    await waitForWidth(296);
    expect(await nameCut()).toBe(false);

    // Dragging far past the maximum stops at 320; double-click goes back to the default.
    await dragBy(400);
    await waitForWidth(320);
    expect(await stored()).toBe("320");
    await browser("screenshot", join(artifacts, "widest.png"));
    await browser("dblclick", HANDLE);
    await waitForWidth(192);
    expect(await stored()).toBe("192");
    expect(await nameCut()).toBe(true);

    // Dragging far to the left of the minimum leaves it at 192, and the same from a wider width.
    await dragBy(-150);
    await waitForWidth(192);
    expect(await stored()).toBe("192");
    await dragBy(100);
    await waitForWidth(292);
    await dragBy(-250);
    await waitForWidth(192);
    expect(await stored()).toBe("192");

    // The keyboard: the arrows step by 16 and stop at the ends.
    await browser("focus", HANDLE);
    await browser("press", "ArrowRight");
    await waitForWidth(208);
    await browser("press", "ArrowRight");
    await waitForWidth(224);
    await browser("press", "ArrowLeft");
    await waitForWidth(208);
    expect(await stored()).toBe("208");
    await browser("press", "ArrowLeft");
    await browser("press", "ArrowLeft");
    await waitForWidth(192);
    expect(await width(SIDEBAR)).toBe(192);
  } finally {
    await browser("eval", `localStorage.removeItem("${KEY}")`).catch(() => undefined);
    await browser("close").catch(() => undefined);
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);
