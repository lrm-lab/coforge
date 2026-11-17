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
//   UI_SWEEP_STRICT       "1": exit non-zero when any capture has a finding, exception or
//                         console error (CI)

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { findChrome, launchChrome, connectPage, pageCtx, sleep } from "./cdp-browser.mjs";
import { filterSweepOptions } from "./ui-sweep-helpers.mjs";
import { CHECKS_EXPR } from "./ui-sweep-checks.mjs";
import { sweepReporter } from "./ui-sweep-report.mjs";

const BASE_URL = (process.env.UI_SWEEP_BASE ?? "http://127.0.0.1:8795").replace(/\/$/, "");
const LOCALE = process.env.UI_SWEEP_LOCALE ?? "en";
const OUT_DIR = process.env.UI_SWEEP_OUT ?? path.join(process.cwd(), "sweep");
const START = Date.now();
const { writeReports, printSummary } = sweepReporter({
  baseUrl: BASE_URL,
  outDir: OUT_DIR,
  start: START,
});

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
              // A dialog leaves through its exit animation: count what is still there once that
              // has had time to run, not in the same frame as the key.
              let after = await page.evalJs('document.querySelectorAll("[role=dialog]").length');
              for (let waited = 0; after !== 0 && waited < 1500; waited += 100) {
                await sleep(100);
                after = await page.evalJs('document.querySelectorAll("[role=dialog]").length');
              }
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
    // In CI (UI_SWEEP_STRICT=1) any finding, page exception or console error fails the run; the
    // report above says which surface, theme and width.
    if (process.env.UI_SWEEP_STRICT === "1") {
      const failures = results.filter(
        (r) => r.findings.length || r.exceptions.length || r.consoleErrors.length,
      ).length;
      if (failures) {
        console.error(`UI sweep: ${failures} capture(s) with findings; see findings.md`);
        process.exitCode = 1;
      }
    }

    ws.close();
  } finally {
    chromeProcess.kill("SIGKILL");
  }
}

if (import.meta.main) await main();
