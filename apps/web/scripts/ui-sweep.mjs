#!/usr/bin/env bun
// Scripted browser walkthrough: visits every route/state/theme/viewport this
// repo's dev seed (`bun run seed:dev`) populates, runs automatic layout
// checks, and writes screenshots plus a findings report.
//
// Run from the repository root with `bun run --cwd apps/web ui:sweep`; the script is this
// package's, so a bare `bun run ui:sweep` from the root finds no such script.
//
// Browser automation: this drives a locally launched Chromium instance over
// the raw Chrome DevTools Protocol (`--remote-debugging-port`), not the
// ego-browser skill — ego-browser's task-space runtime is an interactive tool
// for an agent's own session, not something a checked-in repo script can
// depend on other engineers having installed. Plain CDP has no dependency
// beyond a local Chromium binary (auto-detected; override with
// UI_SWEEP_CHROME_PATH).
//
// Env vars:
//   UI_SWEEP_BASE        base URL of the running dev server (default http://127.0.0.1:8795)
//   UI_SWEEP_OUT          output directory (default ./sweep next to this script's cwd)
//   UI_SWEEP_CHROME_PATH  explicit path to a Chromium/Chrome binary
//   UI_SWEEP_LOCALE       locale path prefix (default "en")
//   UI_SWEEP_THEMES       comma-separated theme names (light,dark)
//   UI_SWEEP_VIEWPORTS    comma-separated viewport names (1440,1024,390)

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { findChrome, launchChrome, connectPage, pageCtx, sleep } from "./cdp-browser.mjs";
import { filterSweepOptions, isInsideViewportScroller } from "./ui-sweep-helpers.mjs";

const BASE_URL = (process.env.UI_SWEEP_BASE ?? "http://127.0.0.1:8795").replace(/\/$/, "");
const LOCALE = process.env.UI_SWEEP_LOCALE ?? "en";
const OUT_DIR = process.env.UI_SWEEP_OUT ?? path.join(process.cwd(), "sweep");
const START = Date.now();

const THEMES = filterSweepOptions(["light", "dark"], process.env.UI_SWEEP_THEMES, "theme");
const VIEWPORTS = filterSweepOptions(
  [
    { name: "1440", width: 1440, height: 900 },
    { name: "1024", width: 1024, height: 768 },
    { name: "390", width: 390, height: 844 },
  ],
  process.env.UI_SWEEP_VIEWPORTS,
  "viewport",
);

const FORBIDDEN_CLASS_PATTERNS = [
  {
    re: /(^|\s)text-muted-foreground(\s|$)/,
    label: "text-muted-foreground (shadcn token, not ours)",
  },
  { re: /(^|\s)bg-muted(\s|$)/, label: "bg-muted (shadcn token, not ours)" },
  { re: /(^|\s)bg-card(\s|$)/, label: "bg-card (shadcn token, not ours)" },
  {
    re: /(^|\s)dark:[a-z-]+-(gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(\s|$)/,
    label: "dark: prefix with a literal Tailwind color (should be a semantic token)",
  },
];

// ---------------------------------------------------------------------------
// In-page automatic layout checks (one Runtime.evaluate round-trip).
// ---------------------------------------------------------------------------
const CHECKS_EXPR = `
(() => {
  const findings = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const isInsideViewportScroller = ${isInsideViewportScroller.toString()};

  function locator(el) {
    if (!el) return null;
    const id = el.id ? "#" + el.id : "";
    const cls = (el.className && typeof el.className === "string")
      ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".")
      : "";
    const text = (el.textContent || "").trim().slice(0, 40);
    return el.tagName.toLowerCase() + id + cls + (text ? ' "' + text + '"' : "");
  }

  // 1. horizontal overflow
  const scrollWidth = document.documentElement.scrollWidth;
  const clientWidth = document.documentElement.clientWidth;
  if (scrollWidth > clientWidth + 1) {
    findings.push({ check: "horizontal-overflow", detail: \`scrollWidth \${scrollWidth} > clientWidth \${clientWidth}\` });
  }

  // 2. elements exceeding viewport horizontally + 3. clipped text
  const all = document.querySelectorAll("body *");
  let oversizedCount = 0;
  let clippedCount = 0;
  for (const el of all) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (
      rect.width > 0 &&
      rect.right > vw + 2 &&
      !isInsideViewportScroller(el, vw) &&
      oversizedCount < 8
    ) {
      findings.push({ check: "element-exceeds-viewport", detail: \`right=\${Math.round(rect.right)} viewport=\${vw}\`, locator: locator(el) });
      oversizedCount++;
    }
    // Ellipsis truncation (Tailwind's "truncate" utility) is this app's
    // deliberate, affordanced way to shorten text in a tight container —
    // only flag a hard clip with no such affordance as a real defect.
    if (
      el.children.length === 0 &&
      el.textContent &&
      el.textContent.trim() &&
      el.clientWidth > 8 &&
      el.scrollWidth > el.clientWidth + 2 &&
      style.textOverflow !== "ellipsis" &&
      clippedCount < 8
    ) {
      findings.push({ check: "clipped-text", detail: \`scrollWidth=\${el.scrollWidth} clientWidth=\${el.clientWidth}\`, locator: locator(el) });
      clippedCount++;
    }
  }

  // 4. fixed/absolute elements overlapping the page <h1>
  const h1 = document.querySelector("h1");
  if (!h1) {
    findings.push({ check: "missing-h1", detail: "no <h1> found on the page" });
  } else {
    const h1Rect = h1.getBoundingClientRect();
    let overlapCount = 0;
    for (const el of all) {
      if (el === h1 || el.contains(h1) || h1.contains(el)) continue;
      // A modal dialog/menu legitimately covers the whole page, including the
      // <h1>, while it is open — that is not a layout defect, so skip any
      // fixed/absolute wrapper that contains one.
      if (el.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) continue;
      const style = getComputedStyle(el);
      if (style.position !== "fixed" && style.position !== "absolute") continue;
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const overlaps = !(r.right <= h1Rect.left || r.left >= h1Rect.right || r.bottom <= h1Rect.top || r.top >= h1Rect.bottom);
      if (overlaps && overlapCount < 5) {
        findings.push({ check: "overlaps-h1", detail: "fixed/absolute element overlaps the page <h1>", locator: locator(el) });
        overlapCount++;
      }
    }
  }

  // 5. buttons/inputs inside headers: height outside [32, 48]
  const headers = document.querySelectorAll("header");
  let headerControlCount = 0;
  for (const header of headers) {
    const controls = header.querySelectorAll('button, input, [role="button"]');
    for (const el of controls) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      if ((r.height < 32 || r.height > 48) && headerControlCount < 8) {
        findings.push({ check: "header-control-size", detail: \`height=\${Math.round(r.height)}px (expected 32-48px)\`, locator: locator(el) });
        headerControlCount++;
      }
    }
  }

  // 6. dialogs whose overlay does not cover the full viewport
  const dialogs = document.querySelectorAll('[role="dialog"]');
  for (const dialog of dialogs) {
    const dr = dialog.getBoundingClientRect();
    // A popover/tooltip is a small dialog — only check overlay coverage for
    // larger, modal-shaped dialogs (roughly > 30% of viewport area).
    const isLikelyModal = dr.width * dr.height > vw * vh * 0.3;
    if (!isLikelyModal) {
      // 7. popovers extending outside the viewport
      if (dr.left < -1 || dr.top < -1 || dr.right > vw + 1 || dr.bottom > vh + 1) {
        findings.push({ check: "popover-outside-viewport", detail: \`rect=\${Math.round(dr.left)},\${Math.round(dr.top)},\${Math.round(dr.right)},\${Math.round(dr.bottom)} viewport=\${vw}x\${vh}\`, locator: locator(dialog) });
      }
      continue;
    }
    let coveringOverlay = null;
    for (const el of all) {
      // Exclude the dialog and anything inside it; an ancestor wrapper is a
      // valid (and common) place for the backdrop to live, so it stays in.
      if (el === dialog || dialog.contains(el)) continue;
      const style = getComputedStyle(el);
      if (style.position !== "fixed") continue;
      if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.left <= 1 && r.top <= 1 && r.right >= vw - 1 && r.bottom >= vh - 1) { coveringOverlay = el; break; }
    }
    if (!coveringOverlay) {
      findings.push({ check: "dialog-overlay-incomplete", detail: "no fixed element found covering the full viewport behind this dialog", locator: locator(dialog) });
    }
  }

  // 8. forbidden classes / hex colors in style
  const forbidden = ${JSON.stringify(FORBIDDEN_CLASS_PATTERNS.map((p) => p.re.source))};
  const forbiddenLabels = ${JSON.stringify(FORBIDDEN_CLASS_PATTERNS.map((p) => p.label))};
  let forbiddenCount = 0;
  let hexCount = 0;
  const isDark = document.documentElement.classList.contains("dark-mode") || document.documentElement.classList.contains("dark");
  for (const el of all) {
    const cls = typeof el.className === "string" ? el.className : "";
    if (cls) {
      for (let i = 0; i < forbidden.length; i++) {
        const label = forbiddenLabels[i];
        if (label.startsWith("dark:") ) { /* handled below with isDark gate for bg-brand-primary only */ }
        const re = new RegExp(forbidden[i]);
        if (re.test(cls) && forbiddenCount < 10) {
          findings.push({ check: "forbidden-class", detail: label, locator: locator(el) });
          forbiddenCount++;
        }
      }
      if (isDark && /(^|\\s)bg-brand-primary(\\s|$)/.test(cls) && forbiddenCount < 10) {
        findings.push({ check: "forbidden-class", detail: "bg-brand-primary used in dark mode", locator: locator(el) });
        forbiddenCount++;
      }
    }
    const inlineStyle = el.getAttribute("style");
    if (inlineStyle && /#[0-9a-fA-F]{3,8}\\b/.test(inlineStyle) && hexCount < 10) {
      findings.push({ check: "hex-color-in-style", detail: inlineStyle.slice(0, 120), locator: locator(el) });
      hexCount++;
    }
  }

  // sidebar width (best effort)
  let sidebarWidth = null;
  const marker = document.querySelector('[aria-label="Resize sidebar"], [aria-label*="Current workspace"]');
  let walker = marker;
  while (walker) {
    const cs = getComputedStyle(walker);
    if (cs.position === "fixed" || walker.tagName === "NAV" || walker.tagName === "ASIDE") {
      sidebarWidth = Math.round(walker.getBoundingClientRect().width);
      break;
    }
    walker = walker.parentElement;
  }

  return {
    findings,
    hasH1: !!h1,
    sidebarWidth,
    dialogCount: dialogs.length,
  };
})()
`;

async function runChecks(page) {
  return page.evalJs(CHECKS_EXPR);
}

// ---------------------------------------------------------------------------
// Surface discovery: resolve seed-created ids from the live app instead of
// hardcoding them, so the sweep works against any seeded workspace.
// ---------------------------------------------------------------------------
async function discoverIds(page) {
  const ids = {
    workspaceSlug: null,
    agentId: null,
    computerId: null,
    channelId: null,
    dmId: null,
  };

  const extract = (linkPattern) => `(() => {
    const re = new RegExp(${JSON.stringify(linkPattern)});
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      const match = href.match(re);
      if (match) return match[1];
    }
    return null;
  })()`;

  // The app root opens the signed-in user's Workspace; every page lives under `/w/<slug>`.
  await page.navigate(`${BASE_URL}/${LOCALE}`);
  ids.workspaceSlug = await page.evalJs(
    `location.pathname.match(new RegExp(${JSON.stringify(`^/${LOCALE}/w/([^/?#]+)`)}))?.[1] ?? null`,
  );
  if (!ids.workspaceSlug)
    throw new Error(
      "Could not discover the Workspace slug: the app root did not open a Workspace (is the dev user signed in with a seeded Workspace?)",
    );
  const workspace = `/${LOCALE}/w/${ids.workspaceSlug}`;

  await page.navigate(`${BASE_URL}${workspace}/members`);
  ids.agentId =
    (await page.evalJs(extract(`${workspace}/agent/([0-9a-fA-F-]{36})(?:[/?]|$)`))) ||
    (await page.evalJs(extract(`profile=agent:([0-9a-fA-F-]{36})`)));

  await page.navigate(`${BASE_URL}${workspace}/computers`);
  ids.computerId = await page.evalJs(extract(`${workspace}/computer/([0-9a-fA-F-]{36})(?:[/?]|$)`));

  await page.navigate(`${BASE_URL}${workspace}`);
  ids.channelId = await page.evalJs(extract(`${workspace}/channel/([0-9a-fA-F-]{36})(?:[/?]|$)`));
  // The sidebar lists only the direct conversations the user already has, each at `dm/<id>`.
  ids.dmId = await page.evalJs(extract(`${workspace}/dm/([0-9a-fA-F-]{36})(?:[/?]|$)`));

  return ids;
}

// ---------------------------------------------------------------------------
// Surface list. `prepare` runs after navigation + theme/viewport emulation,
// before checks + screenshot. `postEscape` marks surfaces that opened an
// overlay, so we verify Escape closes it (dialogCount === 0 after).
// ---------------------------------------------------------------------------
function buildSurfaces(ids) {
  const missing = [];
  if (!ids.agentId) missing.push("agentId");
  if (!ids.computerId) missing.push("computerId");
  if (!ids.channelId) missing.push("channelId");
  if (!ids.dmId) missing.push("dmId");

  const url = (p) => `${BASE_URL}/${LOCALE}/w/${ids.workspaceSlug}${p}`;

  const surfaces = [
    { key: "agents-list", url: url("/members") },
    ids.agentId && {
      key: "agent-detail",
      url: url(`/members?profile=agent:${ids.agentId}`),
    },
    { key: "messages-index", url: url("") },
    ids.channelId && { key: "channel-chat", url: url(`/channel/${ids.channelId}`) },
    ids.channelId && {
      key: "channel-tasks-tab",
      url: url(`/channel/${ids.channelId}`),
      prepare: async (page) => {
        // Scoped to the in-channel Chat/Tasks tab nav — an unscoped "Tasks"
        // text match hits the sidebar's global Tasks nav link first (it comes
        // earlier in the DOM) and navigates away to /tasks instead.
        const ok = await page.clickText("^Tasks", { within: '[aria-label="Chat / Tasks"]' });
        if (!ok) return "could not find the channel Tasks tab";
      },
    },
    ids.channelId && {
      key: "channel-thread-open",
      url: url(`/channel/${ids.channelId}`),
      prepare: async (page) => {
        const ok = await page.clickText("repl"); // "N replies" / "1 reply"
        if (!ok) return "could not find a message with replies to open the thread panel";
      },
      postEscape: true,
    },
    ids.channelId && {
      key: "channel-message-hover",
      url: url(`/channel/${ids.channelId}`),
      prepare: async (page) => {
        const rect = await page.findRectBySelector("main li, main article, main [data-message-id]");
        if (!rect) return "could not find a message row to hover";
        await page.mouseMove(rect.x, rect.y);
        await sleepScript(300);
      },
    },
    ids.dmId && { key: "dm-conversation", url: url(`/dm/${ids.dmId}`) },
    { key: "tasks-board", url: url("/tasks?layout=board") },
    { key: "tasks-list", url: url("/tasks?layout=list") },
    { key: "computers-list", url: url("/computers") },
    ids.computerId && {
      key: "computer-detail-runtime-popover",
      url: url(`/computer/${ids.computerId}`),
      prepare: async (page) => {
        const ok =
          (await page.hoverText("Claude Code")) ||
          (await page.hoverText("Codex")) ||
          (await page.hoverText("^Pi$"));
        if (!ok) return "could not find a runtime row to hover for the usage popover";
      },
    },
    { key: "settings-account", url: url("/settings?section=account") },
    { key: "settings-preferences", url: url("/settings?section=preferences") },
    { key: "settings-notifications", url: url("/settings?section=notifications") },
    { key: "settings-members", url: url("/settings?section=members") },
    {
      key: "settings-account-edit-form",
      url: url("/settings?section=account"),
      prepare: async (page) => {
        const ok = await page.clickText("^Edit$");
        if (!ok) return "could not find the profile Edit button";
      },
    },
    {
      key: "dialog-create-channel",
      url: url(""),
      prepare: async (page) => {
        const ok = await page.clickText("Create Channel");
        if (!ok) return "could not find the Create channel trigger";
      },
      postEscape: true,
    },
    {
      key: "dialog-new-agent",
      url: url("/members"),
      prepare: async (page) => {
        const ok = await page.clickText("New Agent");
        if (!ok) return "could not find the New Agent trigger";
      },
      postEscape: true,
    },
    {
      key: "dialog-add-computer-step1",
      url: url("/computers"),
      prepare: async (page) => {
        const ok = await page.clickText("Add Computer");
        if (!ok) return "could not find the Add computer trigger";
      },
      postEscape: true,
    },
    {
      key: "dialog-add-computer-step2",
      url: url("/computers"),
      prepare: async (page) => {
        if (!(await page.clickText("Add Computer")))
          return "could not find the Add computer trigger";
        if (!(await page.clickText("Your computer")))
          return "could not select the local computer option";
        if (!(await page.clickText("^Next$"))) return "could not advance to the install step";
      },
      postEscape: true,
    },
    // The standalone /tasks board is read-only; "Create task" only exists on
    // a channel's embedded task board (its Tasks tab), so open it from there.
    ids.channelId && {
      key: "dialog-create-task",
      url: url(`/channel/${ids.channelId}`),
      prepare: async (page) => {
        if (!(await page.clickText("^Tasks", { within: '[aria-label="Chat / Tasks"]' })))
          return "could not find the channel Tasks tab";
        await sleepScript(500); // the Tasks tab is a route search-param change; let it settle
        const ok = await page.clickText("Create Task");
        if (!ok) return "could not find the Create task trigger";
      },
      postEscape: true,
    },
    {
      key: "menu-workspace-switcher",
      url: url("/members"),
      prepare: async (page) => {
        const opened = await page.clickText("Current workspace");
        if (!opened) return "could not find the workspace switcher trigger";
      },
      postEscape: true,
    },
    {
      key: "menu-user-menu",
      url: url("/members"),
      prepare: async (page) => {
        const ok = await page.clickText("Current user");
        if (!ok) return "could not find the user menu trigger";
      },
      postEscape: true,
    },
    {
      key: "sidebar-collapsed-tooltip",
      url: url("/members"),
      prepare: async (page) => {
        const collapsed = await page.clickText("Hide Sidebar");
        if (!collapsed) return "could not find the sidebar collapse control";
        const hovered = await page.hoverText("Show sidebar");
        if (!hovered) return "collapsed sidebar, but could not hover its expand tooltip";
      },
    },
    {
      key: "sidebar-mid-resize",
      url: url("/members"),
      prepare: async (page) => {
        const rect = await page.findRectBySelector('[aria-label="Resize sidebar"]');
        if (!rect) return "could not find the sidebar resize handle";
        await page.mouseDown(rect.x, rect.y);
        await page.mouseMove(rect.x + 60, rect.y);
        await sleepScript(150);
        // deliberately leave the mouse "down" for the screenshot, then release.
      },
      cleanup: async (page) => {
        await page.mouseUp(0, 0);
      },
    },
  ];

  return { surfaces: surfaces.filter(Boolean), missing };
}

function sleepScript(ms) {
  return sleep(ms);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const chromePath = await findChrome();
  console.log(`Using Chromium at: ${chromePath}`);
  const port = 9333 + (process.pid % 500);
  const chromeProcess = await launchChrome(chromePath, port);

  const results = [];
  const notes = [];

  try {
    const { cdp, sessionId, ws } = await connectPage(port);
    const page = pageCtx(cdp, sessionId);

    console.log(`Base URL: ${BASE_URL}`);
    console.log("Discovering seeded ids…");
    await page.setViewport(1440, 900);
    await page.setTheme("light");
    const ids = await discoverIds(page);
    console.log("Discovered:", ids);

    const { surfaces, missing } = buildSurfaces(ids);
    if (missing.length) {
      notes.push(
        `Could not discover: ${missing.join(", ")} — surfaces depending on them were skipped.`,
      );
    }

    let visited = 0;
    const total = surfaces.length * THEMES.length * VIEWPORTS.length;

    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        await page.setViewport(viewport.width, viewport.height);
        await page.setTheme(theme);

        for (const surface of surfaces) {
          visited++;
          const name = `${surface.key}--${theme}--${viewport.name}`;
          const screenshotPath = path.join(OUT_DIR, `${name}.png`);
          const record = {
            surface: surface.key,
            theme,
            width: viewport.width,
            height: viewport.height,
            screenshot: `${name}.png`,
            note: null,
            findings: [],
            consoleErrors: [],
            consoleWarnings: [],
            exceptions: [],
            hasH1: null,
            sidebarWidth: null,
            dialogCountAfterEscape: null,
          };

          try {
            await page.navigate(surface.url);
            if (surface.prepare) {
              const note = await surface.prepare(page);
              if (note) record.note = note;
            }

            const checks = await runChecks(page);
            record.findings = checks.findings;
            record.hasH1 = checks.hasH1;
            record.sidebarWidth = checks.sidebarWidth;

            const consoleState = page.consoleSnapshot();
            record.consoleErrors = consoleState.errors;
            record.consoleWarnings = consoleState.warnings;
            record.exceptions = page.exceptionsSnapshot();
            const hydrationWarnings = [...consoleState.errors, ...consoleState.warnings].filter(
              (m) => /hydrat/i.test(m),
            );
            if (hydrationWarnings.length) {
              record.findings.push({
                check: "hydration-warning",
                detail: hydrationWarnings.join(" | ").slice(0, 300),
              });
            }

            await page.screenshot(screenshotPath);

            if (surface.postEscape) {
              await page.pressEscape();
              const after = await page.evalJs('document.querySelectorAll("[role=dialog]").length');
              record.dialogCountAfterEscape = after;
              if (after !== 0) {
                record.findings.push({
                  check: "escape-does-not-close-dialog",
                  detail: `${after} [role=dialog] element(s) remain after Escape`,
                });
              }
            }

            if (surface.cleanup) await surface.cleanup(page);
          } catch (error) {
            record.note = `error: ${error instanceof Error ? error.message : String(error)}`;
            try {
              await page.screenshot(screenshotPath);
            } catch {
              record.screenshot = null;
            }
          }

          results.push(record);
          if (visited % 10 === 0 || visited === total) {
            console.log(
              `  ${visited}/${total} captured (${record.surface} · ${theme} · ${viewport.name})`,
            );
          }
        }
      }
    }

    // Extra: resize 1440 -> 1920 while a dialog is open (once per theme).
    for (const theme of THEMES) {
      await page.setViewport(1440, 900);
      await page.setTheme(theme);
      const name = `dialog-resize-1440-to-1920--${theme}--1440to1920`;
      const record = {
        surface: "dialog-resize-1440-to-1920",
        theme,
        width: 1920,
        height: 900,
        screenshot: `${name}.png`,
        note: null,
        findings: [],
        consoleErrors: [],
        consoleWarnings: [],
        exceptions: [],
        hasH1: null,
        sidebarWidth: null,
        dialogCountAfterEscape: null,
      };
      try {
        await page.navigate(url_messages());
        const opened = await page.clickText("Create Channel");
        if (!opened) record.note = "could not find the Create channel trigger";
        await page.setViewport(1920, 900);
        await sleep(400);
        const checks = await runChecks(page);
        record.findings = checks.findings;
        record.hasH1 = checks.hasH1;
        await page.screenshot(path.join(OUT_DIR, `${name}.png`));
        await page.pressEscape();
      } catch (error) {
        record.note = `error: ${error instanceof Error ? error.message : String(error)}`;
      }
      results.push(record);

      function url_messages() {
        return `${BASE_URL}/${LOCALE}/w/${ids.workspaceSlug}`;
      }
    }

    writeReports(results, notes);
    printSummary(results);

    ws.close();
  } finally {
    chromeProcess.kill("SIGKILL");
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
async function writeReports(results, notes) {
  await writeFile(
    path.join(OUT_DIR, "findings.json"),
    JSON.stringify({ baseUrl: BASE_URL, notes, results }, null, 2),
  );

  const byCheck = new Map();
  for (const r of results) {
    for (const f of r.findings) {
      if (!byCheck.has(f.check)) byCheck.set(f.check, []);
      byCheck.get(f.check).push({
        ...f,
        surface: r.surface,
        theme: r.theme,
        width: r.width,
        screenshot: r.screenshot,
      });
    }
    for (const e of r.consoleErrors) {
      if (!byCheck.has("console-error")) byCheck.set("console-error", []);
      byCheck.get("console-error").push({
        detail: e,
        surface: r.surface,
        theme: r.theme,
        width: r.width,
        screenshot: r.screenshot,
      });
    }
    for (const e of r.exceptions) {
      if (!byCheck.has("exception-thrown")) byCheck.set("exception-thrown", []);
      byCheck.get("exception-thrown").push({
        detail: e,
        surface: r.surface,
        theme: r.theme,
        width: r.width,
        screenshot: r.screenshot,
      });
    }
  }

  const lines = [];
  lines.push(`# UI sweep findings`);
  lines.push("");
  lines.push(`Base URL: ${BASE_URL}`);
  lines.push(`Surfaces captured: ${results.length}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  if (notes.length) {
    lines.push("## Notes");
    for (const n of notes) lines.push(`- ${n}`);
    lines.push("");
  }

  const reachNotes = results.filter((r) => r.note);
  if (reachNotes.length) {
    lines.push("## Surfaces the sweep could not fully reach");
    for (const r of reachNotes) lines.push(`- ${r.surface} (${r.theme}, ${r.width}px): ${r.note}`);
    lines.push("");
  }

  lines.push("## Findings by check");
  for (const [check, items] of [...byCheck.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`### ${check} (${items.length})`);
    for (const item of items.slice(0, 20)) {
      lines.push(
        `- **${item.surface}** · ${item.theme} · ${item.width}px — ${item.detail}${item.locator ? ` \`${item.locator}\`` : ""} ([${item.screenshot}](./${item.screenshot}))`,
      );
    }
    if (items.length > 20) lines.push(`- … ${items.length - 20} more`);
    lines.push("");
  }

  await writeFile(path.join(OUT_DIR, "findings.md"), lines.join("\n"));

  const html = buildContactSheet(results);
  await writeFile(path.join(OUT_DIR, "index.html"), html);
}

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function buildContactSheet(results) {
  const rows = results
    .map((r) => {
      const findingsHtml = r.findings
        .map(
          (f) =>
            `<li><b>${esc(f.check)}</b>: ${esc(f.detail)}${f.locator ? ` <code>${esc(f.locator)}</code>` : ""}</li>`,
        )
        .join("");
      const consoleHtml = [
        ...r.consoleErrors.map((e) => `<li class="err">console.error: ${esc(e)}</li>`),
        ...r.exceptions.map((e) => `<li class="err">exception: ${esc(e)}</li>`),
      ].join("");
      const clean =
        r.findings.length === 0 &&
        r.consoleErrors.length === 0 &&
        r.exceptions.length === 0 &&
        !r.note;
      return `<section class="card ${clean ? "clean" : "flagged"}">
  <h3>${esc(r.surface)} <span class="tag">${esc(r.theme)}</span> <span class="tag">${r.width}px</span></h3>
  ${r.note ? `<p class="note">${esc(r.note)}</p>` : ""}
  ${r.screenshot ? `<img loading="lazy" src="${esc(r.screenshot)}" alt="${esc(r.surface)}" />` : "<p>no screenshot</p>"}
  <ul class="findings">${findingsHtml}${consoleHtml}</ul>
  ${r.sidebarWidth != null ? `<p class="meta">sidebar width: ${r.sidebarWidth}px</p>` : ""}
</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>UI sweep — ${esc(BASE_URL)}</title>
<style>
  body { font: 14px/1.4 -apple-system, sans-serif; background: #f7f7f8; color: #111; margin: 0; padding: 24px; }
  h1 { font-size: 18px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
  .card { background: #fff; border: 1px solid #e2e2e5; border-radius: 8px; padding: 12px; }
  .card.flagged { border-color: #e58a8a; }
  .card h3 { margin: 0 0 8px; font-size: 13px; }
  .tag { display: inline-block; font-size: 11px; color: #555; border: 1px solid #ddd; border-radius: 4px; padding: 0 4px; margin-left: 4px; }
  img { width: 100%; border: 1px solid #ddd; border-radius: 4px; }
  .findings { font-size: 12px; padding-left: 18px; margin: 8px 0 0; }
  .findings li.err { color: #a11; }
  .note { color: #a15c00; font-size: 12px; }
  .meta { font-size: 11px; color: #777; }
</style>
</head>
<body>
<h1>UI sweep — ${esc(BASE_URL)} — ${results.length} captures</h1>
<div class="grid">
${rows}
</div>
</body>
</html>`;
}

function printSummary(results) {
  const byCheck = new Map();
  for (const r of results) {
    for (const f of r.findings) byCheck.set(f.check, (byCheck.get(f.check) ?? 0) + 1);
    if (r.consoleErrors.length)
      byCheck.set("console-error", (byCheck.get("console-error") ?? 0) + r.consoleErrors.length);
    if (r.exceptions.length)
      byCheck.set("exception-thrown", (byCheck.get("exception-thrown") ?? 0) + r.exceptions.length);
  }
  const elapsed = ((Date.now() - START) / 1000).toFixed(1);
  console.log("");
  console.log(`Sweep finished in ${elapsed}s — ${results.length} surface/theme/viewport captures.`);
  console.log("");
  console.log("Check                          Count");
  console.log("------------------------------  -----");
  for (const [check, count] of [...byCheck.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${check.padEnd(30)}  ${String(count).padStart(5)}`);
  }
  if (byCheck.size === 0) console.log("(no findings)");
  console.log("");
  console.log(`Output: ${OUT_DIR}`);
  console.log(`  - ${path.join(OUT_DIR, "findings.json")}`);
  console.log(`  - ${path.join(OUT_DIR, "findings.md")}`);
  console.log(`  - ${path.join(OUT_DIR, "index.html")}`);
}

if (import.meta.main) await main();
