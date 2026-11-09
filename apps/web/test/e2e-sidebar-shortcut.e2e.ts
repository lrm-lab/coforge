import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageWaiter } from "./helpers/browser-e2e";

/**
 * Task #232: Cmd+B (Ctrl+B off Apple platforms) collapses and expands the desktop sidebar, also
 * while typing in the message composer, and the toggle's tooltip names the shortcut. In a
 * rich-text editor the key stays bold, so the sidebar does not move.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`) + `agent-browser`
 * against the dev database. It creates nothing and clears the preference key it sets.
 * Screenshots are written under `.amp/e2e/sidebar-shortcut/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/sidebar-shortcut");

test("Cmd/Ctrl+B toggles the sidebar, except in a rich-text editor", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `sidebar-shortcut-${process.pid}`;
  const { browser, evaluate } = browserSession(browserPath, session);
  const wait = pageWaiter(browserPath)(session, browser);
  const collapsed = () =>
    evaluate<boolean>(`document.documentElement.classList.contains("sidebar-collapsed")`);
  const waitCollapsed = (value: boolean) =>
    wait(`document.documentElement.classList.contains("sidebar-collapsed") === ${value}`);
  /** The shortcut as the page's platform spells it, for `press` and the tooltip. */
  const apple = () => evaluate<boolean>(`/Mac|iPhone|iPad|iPod/i.test(navigator.platform)`);
  const COLLAPSE = 'button[aria-label="Collapse sidebar"]';
  const EXPAND = 'button[aria-label="Expand sidebar"]';
  /** Moves a real pointer onto a button, from off it, so its tooltip opens. The button can still
   * be moving (the rail's width transition, a late list row) between measuring and the move, so
   * each attempt confirms the point lands on the button before the tooltip wait relies on it. */
  async function hover(selector: string) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const [x, y] = await evaluate<[number, number]>(
        `(() => { const box = document.querySelector('${selector}').getBoundingClientRect(); return [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)]; })()`,
      );
      await browser("mouse", "move", "700", "450");
      await browser("mouse", "move", String(x), String(y));
      const landed = await evaluate<boolean>(
        `(() => { const el = document.querySelector('${selector}'); const hit = document.elementFromPoint(${x}, ${y}); return Boolean(el && hit && (hit === el || el.contains(hit))); })()`,
      );
      if (landed) return;
      await browser("wait", "100");
    }
  }
  /** Hovers until the button's tooltip opens and returns its text, read in the same page
   * evaluation that first sees it: a tooltip can close again before a second DOM read (a hover
   * end, another trigger's warmup, an unmount), so seeing it and reading it must be one
   * observation. `title` names the tooltip wanted, so a previous button's still-closing tooltip
   * does not count. */
  async function tooltipAfterHover(selector: string, title: string) {
    for (let attempt = 0; attempt < 4; attempt++) {
      await hover(selector);
      const shown = JSON.parse(
        await browser(
          "eval",
          `new Promise((done) => {
            const started = Date.now();
            const tick = () => {
              const tip = [...document.querySelectorAll('[role="tooltip"]')].find((tip) => tip.textContent.includes(${JSON.stringify(title)}));
              if (tip) done(tip.textContent);
              else if (Date.now() - started > 4000) done(null);
              else setTimeout(tick, 100);
            };
            tick();
          })`,
        ),
      ) as string | null;
      if (shown !== null) return shown;
    }
    throw new Error(`the ${selector} tooltip never opened`);
  }

  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${membership.workspace.slug}`);
    await browser("eval", `localStorage.removeItem("coforge-sidebar-expanded")`);
    await browser("reload");
    await wait(`document.querySelector('${COLLAPSE}') !== null`);
    expect(await collapsed()).toBe(false);
    const mac = await apple();
    const [press, label] = mac ? ["Meta+b", "⌘B"] : ["Control+b", "Ctrl+B"];

    // The collapse button's tooltip names the shortcut.
    expect(await tooltipAfterHover(COLLAPSE, "Collapse sidebar")).toBe(`Collapse sidebar${label}`);
    await browser("screenshot", join(artifacts, "collapse-tooltip.png"));

    // From the page, and from the message composer while typing, the key collapses and expands.
    await browser("press", press);
    await waitCollapsed(true);
    expect(await evaluate<string | null>(`localStorage.getItem("coforge-sidebar-expanded")`)).toBe(
      "hide",
    );
    // The collapse animates the rail's width; measuring the expand button mid-transition
    // puts the pointer where the button was, and no tooltip ever opens.
    await wait(`document.getAnimations().every((a) => a.playState !== "running")`);
    expect(await tooltipAfterHover(EXPAND, "Expand sidebar")).toBe(`Expand sidebar${label}`);
    await browser("screenshot", join(artifacts, "expand-tooltip.png"));
    await browser("focus", "textarea");
    await browser("press", press);
    await waitCollapsed(false);

    // In a rich-text editor the key is left to it.
    await browser(
      "eval",
      `(() => { const editor = document.createElement("div"); editor.contentEditable = "true"; editor.id = "e2e-editor"; document.body.append(editor); })()`,
    );
    await browser("focus", "#e2e-editor");
    await browser("press", press);
    await browser("wait", "300");
    expect(await collapsed()).toBe(false);
  } finally {
    await browser("eval", `localStorage.removeItem("coforge-sidebar-expanded")`).catch(
      () => undefined,
    );
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
