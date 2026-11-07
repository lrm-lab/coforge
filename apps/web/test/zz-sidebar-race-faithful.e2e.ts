import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageWaiter } from "./helpers/browser-e2e";

/**
 * THROWAWAY diagnostic for the one-time e2e-sidebar-shortcut tooltip flake (task #525 follow-up).
 * Replays the original file's exact steps — collapse tooltip, Cmd/Ctrl+B, expand tooltip — once
 * per page load, `ROUNDS` times, while a page-side recorder captures every boundary pointer
 * event, tooltip DOM mutation and a 200ms heartbeat (hover state, topmost element at the last
 * pointer position, running animations). Each round's trace lands in
 * .amp/e2e/sidebar-tooltip-race-faithful/round-N.json; the file then fails on purpose so the
 * shard uploads the artifacts. Never lands on main.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const outDir = join(import.meta.dir, "../../../.amp/e2e/sidebar-tooltip-race-faithful");
const ROUNDS = 6;

// Page-side recorder. Installed after every load/reload; fills window.__rr = {trace, hb}.
const INSTALL = `(() => {
  if (window.__rr) return "already";
  const S = (window.__rr = { trace: [], hb: [], t0: performance.now(), last: null });
  const T = () => Math.round(performance.now() - S.t0);
  const cap = (a, n) => { if (a.length > n) a.splice(0, a.length - n); };
  const desc = (el) => {
    if (!el || el.nodeType !== 1) return String(el && el.nodeName || el);
    let s = el.tagName.toLowerCase();
    const al = el.getAttribute && el.getAttribute("aria-label");
    if (al) s += "[" + al.slice(0, 40) + "]";
    if (el.id) s += "#" + el.id;
    const cn = el.className;
    const cls = typeof cn === "string" ? cn : (cn && cn.baseVal) || "";
    const first = cls.trim().split(/\\s+/).slice(0, 2).join(".");
    if (first) s += "." + first;
    if (el.closest) {
      if (el.closest('button[aria-label="Expand Sidebar"]')) s += "<EXPAND";
      if (el.closest('button[aria-label="Collapse sidebar"]')) s += "<COLLAPSE";
      if (el.closest('[role="tooltip"]')) s += "<TIP";
    }
    return s.slice(0, 120);
  };
  const push = (o) => { S.trace.push(o); cap(S.trace, 80000); };
  const types = ["pointerover", "pointerout", "pointerenter", "pointerleave", "pointerdown", "pointerup", "click", "focusin", "focusout"];
  for (const t of types) {
    document.addEventListener(t, (e) => {
      S.last = { x: e.clientX, y: e.clientY };
      push({ t: T(), e: t, x: e.clientX, y: e.clientY, pt: e.pointerType || "", tg: desc(e.target) });
    }, true);
  }
  document.addEventListener("pointermove", (e) => { S.last = { x: e.clientX, y: e.clientY }; }, true);
  addEventListener("resize", () => push({ t: T(), e: "resize" }));
  document.addEventListener("scroll", () => push({ t: T(), e: "scroll", tg: desc(document.elementFromPoint(S.last ? S.last.x : -1, S.last ? S.last.y : -1)) }), true);
  const tipText = (n) => {
    if (!n || n.nodeType !== 1) return null;
    const tip = n.matches && n.matches('[role="tooltip"]') ? n : n.querySelector && n.querySelector('[role="tooltip"]');
    if (!tip) return null;
    return (tip.textContent || "").replace(/\\s+/g, " ").slice(0, 60);
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "childList") {
        for (const n of m.addedNodes) { const d = tipText(n); if (d !== null) push({ t: T(), e: "tip+", d }); }
        for (const n of m.removedNodes) { const d = tipText(n); if (d !== null) push({ t: T(), e: "tip-", d }); }
      } else if (m.target && m.target.matches && m.target.matches('[role="tooltip"]')) {
        push({ t: T(), e: "tip-attr", a: m.attributeName, v: String(m.target.getAttribute(m.attributeName)).slice(0, 20), d: (m.target.textContent || "").replace(/\\s+/g, " ").slice(0, 60) });
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-exiting"] });
  setInterval(() => {
    const ex = document.querySelector('button[aria-label="Expand Sidebar"]');
    const cl = document.querySelector('button[aria-label="Collapse sidebar"]');
    const tips = [...document.querySelectorAll('[role="tooltip"]')].map((t) => ({
      x: (t.textContent || "").replace(/\\s+/g, " ").slice(0, 50),
      ex: t.hasAttribute("data-exiting") ? 1 : 0,
    }));
    const top = S.last ? desc(document.elementFromPoint(S.last.x, S.last.y)) : "";
    S.hb.push({
      t: T(),
      eh: ex ? (ex.matches(":hover") ? 1 : 0) : -1,
      ch: cl ? (cl.matches(":hover") ? 1 : 0) : -1,
      top,
      tips,
      an: document.getAnimations ? document.getAnimations().filter((a) => a.playState === "running").length : -1,
    });
    cap(S.hb, 40000);
  }, 200);
  return "ok";
})()`;

test("sidebar expand tooltip race — faithful replay with trace", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `sidebar-race-faithful-${process.pid}`;
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
  // Same polling as the original, but reports whether the wanted tooltip was ever seen.
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
  const mark = (name: string) =>
    evaluate(`window.__rr && window.__rr.trace.push({ t: Math.round(performance.now() - window.__rr.t0), e: "MARK", d: ${JSON.stringify(name)} }), true`);

  const results: string[] = [];
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    await mkdir(outDir, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    const mac = await (async () => {
      await browser("open", `${origin}/en/w/${membership.workspace.slug}`);
      return apple();
    })();
    const [press] = mac ? ["Meta+b"] : ["Control+b"];

    for (let round = 0; round < ROUNDS; round++) {
      let line = `round ${round}`;
      try {
        await browser("open", `${origin}/en/w/${membership.workspace.slug}`);
        await browser("eval", `localStorage.removeItem("coforge-sidebar-expanded")`);
        await browser("reload");
        await browser("eval", INSTALL);
        await wait(`document.querySelector('${COLLAPSE}') !== null`);
        const seenCollapse = await tooltipAfterHover(COLLAPSE, "Collapse sidebar");
        await wait(`document.querySelector('[role="tooltip"]') !== null`);
        const collapseTip = await tooltip("Collapse sidebar");
        await browser("press", press);
        await waitCollapsed(true);
        await wait(`document.getAnimations().every((a) => a.playState !== "running")`);
        await mark("expand-hover-start");
        const seenExpand = await tooltipAfterHover(EXPAND, "Expand Sidebar");
        await mark("expand-hover-end");
        await wait(`document.querySelector('[role="tooltip"]') !== null`);
        const expandTip = await tooltip("Expand Sidebar");
        line += ` collapseSeen=${seenCollapse} collapseTip=${JSON.stringify(collapseTip)} expandSeen=${seenExpand} expandTip=${JSON.stringify(expandTip)}`;
      } catch (error) {
        line += ` ERROR ${String(error).slice(0, 200)}`;
      }
      const dump = await evaluate<string>(`JSON.stringify(window.__rr || null)`).catch(() => "null");
      await writeFile(join(outDir, `round-${round}.json`), dump);
      results.push(line);
      console.log(`RACE ${line}`);
      await browser("eval", `window.__rr = null`).catch(() => undefined);
    }
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
  // Force the file red so the shard uploads .amp/e2e screenshots (the traces) and this log.
  expect(results.join("\n")).toContain("__never__");
}, 340_000);
