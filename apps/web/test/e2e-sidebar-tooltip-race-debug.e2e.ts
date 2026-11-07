import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageWaiter } from "./helpers/browser-e2e";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/sidebar-tooltip-race-debug");

const INIT = `(() => {
  window.__log = [];
  const t0 = performance.now();
  const rec = (kind, detail) => window.__log.push(\`\${(performance.now() - t0).toFixed(0)} \${kind} \${detail}\`);
  const describe = (el) => {
    if (!el || el === window || el === document) return String(el && el.constructor ? el.constructor.name : el);
    const aria = el.getAttribute && el.getAttribute("aria-label");
    const id = el.id ? "#" + el.id : "";
    return \`\${el.tagName}\${id}\${aria ? "[" + aria + "]" : ""}\`;
  };
  for (const type of ["pointerover", "pointerout", "pointerenter", "pointerleave", "pointermove", "pointerdown", "pointerup", "mousedown", "mouseup", "mouseover", "mouseout", "click", "focusin", "focusout", "keydown", "keyup"]) {
    document.addEventListener(type, (e) => {
      const expand = document.querySelector('button[aria-label="Expand Sidebar"]');
      rec(type, \`t=\${describe(e.target)} r=\${describe(e.relatedTarget)} pt=\${e.pointerType || ""} key=\${e.key || ""} ctrl=\${e.ctrlKey || ""} expHover=\${expand ? expand.matches(":hover") : "?"}\`);
    }, true);
  }
  const seen = (n) => n.nodeType === 1 && (n.matches?.('[role="tooltip"]') || n.querySelector?.('[role="tooltip"]'));
  const tipOf = (n) => n.matches?.('[role="tooltip"]') ? n : n.querySelector?.('[role="tooltip"]');
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => { if (seen(n)) rec("TIP+", (tipOf(n).textContent || "").slice(0, 60)); });
      m.removedNodes.forEach((n) => { if (seen(n)) rec("TIP-", (tipOf(n).textContent || "").slice(0, 60)); });
    }
  });
  const start = () => {
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(() => {
      const tips = [...document.querySelectorAll('[role="tooltip"]')];
      rec("POLL", tips.length ? tips.map((t) => (t.textContent || "").slice(0, 30)).join(" | ") : "(none)");
    }, 50);
  };
  if (document.documentElement) start(); else addEventListener("DOMContentLoaded", start);
})();`;

test("sidebar expand tooltip race debug", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `sidebar-race-${process.pid}`;
  const { browser, evaluate } = browserSession(browserPath, session);
  const wait = pageWaiter(browserPath)(session, browser);
  const collapsed = () =>
    evaluate<boolean>(`document.documentElement.classList.contains("sidebar-collapsed")`);
  const waitCollapsed = (value: boolean) =>
    wait(`document.documentElement.classList.contains("sidebar-collapsed") === ${value}`);
  const apple = () => evaluate<boolean>(`/Mac|iPhone|iPad|iPod/i.test(navigator.platform)`);
  const COLLAPSE = 'button[aria-label="Collapse sidebar"]';
  const EXPAND = 'button[aria-label="Expand Sidebar"]';
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
  async function tooltipAfterHover(selector: string, title: string) {
    for (let attempt = 0; attempt < 4; attempt++) {
      await hover(selector);
      const shown = JSON.parse(
        await browser(
          "eval",
          `new Promise((done) => {
            const started = Date.now();
            const tick = () => {
              const open = [...document.querySelectorAll('[role="tooltip"]')].some((tip) => tip.textContent.includes(${JSON.stringify(title)}));
              if (open) done(true);
              else if (Date.now() - started > 4000) done(false);
              else setTimeout(tick, 100);
            };
            tick();
          })`,
        ),
      );
      if (shown) return true;
    }
    return false;
  }
  const tooltip = (title: string) =>
    evaluate<string | null>(
      `[...document.querySelectorAll('[role="tooltip"]')].find((tip) => tip.textContent.includes(${JSON.stringify(title)}))?.textContent ?? null`,
    );

  try {
    await mkdir(artifacts, { recursive: true });
    const initFile = join(artifacts, "init.js");
    await writeFile(initFile, INIT);
    await browser("--init-script", initFile, "set", "viewport", "1440", "900");
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    await browser("open", `${origin}/en/w/${membership.workspace.slug}`);
    await browser("eval", `localStorage.removeItem("coforge-sidebar-expanded")`);
    await browser("reload");
    await wait(`document.querySelector('${COLLAPSE}') !== null`);
    expect(await collapsed()).toBe(false);
    const mac = await apple();
    const press = mac ? "Meta+b" : "Control+b";

    const failures: number[] = [];
    for (let round = 0; round < 12; round++) {
      // Ensure expanded, then collapse via the shortcut.
      if (await collapsed()) await browser("press", press);
      await waitCollapsed(false);
      await browser("press", press);
      await waitCollapsed(true);
      await wait(`document.getAnimations().every((a) => a.playState !== "running")`);
      const mark = await evaluate<number>(`window.__log.length`);
      const shown = await tooltipAfterHover(EXPAND, "Expand Sidebar");
      const got = await tooltip("Expand Sidebar");
      if (!shown || got === null) {
        failures.push(round);
        const slice = await evaluate<string>(
          `JSON.stringify((window.__log || []).slice(${mark}))`,
        );
        await writeFile(join(artifacts, `fail-round-${round}.json`), slice);
        console.log(`ROUND ${round}: shown=${shown} tooltip=${JSON.stringify(got)}`);
      } else {
        console.log(`round ${round}: ok`);
      }
      // Re-expand for the next round via the shortcut.
      await browser("press", press);
      await waitCollapsed(false);
    }
    const log = await evaluate<string>(`JSON.stringify(window.__log || [])`);
    await writeFile(join(artifacts, `full-${Date.now()}.json`), log);
    expect(failures).toEqual([]);
  } finally {
    await browser("eval", `localStorage.removeItem("coforge-sidebar-expanded")`).catch(() => undefined);
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 360_000);
