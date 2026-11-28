#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  CdpConnectionError,
  findChrome,
  launchChrome,
  connectPage,
  pageCtx,
  sleep,
} from "./cdp-browser.mjs";
import { filterSweepOptions } from "./ui-sweep-helpers.mjs";
import { CHECKS_EXPR } from "./ui-sweep-checks.mjs";
import { sweepReporter } from "./ui-sweep-report.mjs";
import { buildSurfaces } from "./ui-sweep-surfaces.mjs";

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

async function discoverIds(page) {
  const ids = {
    workspaceSlug: null,
    agentId: null,
    computerId: null,
    channelId: null,
    dmId: null,
    channelTaskChannelId: null,
    channelTaskNumber: null,
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

  const extractPair = (linkPattern, allowedFirst = null) => `(() => {
    const re = new RegExp(${JSON.stringify(linkPattern)});
    const allowed = ${allowedFirst ? `new Set(${JSON.stringify(allowedFirst)})` : "null"};
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      const match = href.match(re);
      if (match && (!allowed || allowed.has(match[1]))) return [match[1], match[2]];
    }
    return null;
  })()`;

  const extractAll = (linkPattern, limit = 5) => `(() => {
    const re = new RegExp(${JSON.stringify(linkPattern)});
    const seen = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      const match = href.match(re);
      if (match && !seen.includes(match[1])) {
        seen.push(match[1]);
        if (seen.length >= ${limit}) break;
      }
    }
    return seen;
  })()`;

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
    (await page.evalJs(extract(`profile=agent(?::|%3A)([0-9a-fA-F-]{36})`)));

  await page.navigate(`${BASE_URL}${workspace}/computers`);
  ids.computerId = await page.evalJs(extract(`${workspace}/computer/([0-9a-fA-F-]{36})(?:[/?]|$)`));

  await page.navigate(`${BASE_URL}${workspace}`);
  const channelIds = await page.evalJs(
    extractAll(`${workspace}/channel/([0-9a-fA-F-]{36})(?:[/?]|$)`, 5),
  );
  ids.channelId = channelIds[0] ?? null;
  ids.dmId = await page.evalJs(extract(`${workspace}/dm/([0-9a-fA-F-]{36})(?:[/?]|$)`));

  if (channelIds.length > 0) {
    await page.navigate(`${BASE_URL}${workspace}/tasks?layout=list`);
    const taskPair =
      (await page.evalJs(extractPair(`task=([0-9a-fA-F-]{36})(?::|%3A)(\\d+)`, channelIds))) ||
      (await page.evalJs(extractPair(`channel/([0-9a-fA-F-]{36})[^"']*[?&]task=(\\d+)`)));
    if (taskPair) {
      ids.channelTaskChannelId = taskPair[0];
      ids.channelTaskNumber = taskPair[1];
    } else {
      for (const cid of channelIds) {
        await page.navigate(`${BASE_URL}${workspace}/channel/${cid}?task=1`);
        const hasTaskDetail = await page.evalJs(
          `Boolean(document.querySelector('[data-task-detail]'))`,
        );
        if (hasTaskDetail) {
          ids.channelTaskChannelId = cid;
          ids.channelTaskNumber = "1";
          break;
        }
      }
    }
  }

  return ids;
}

export async function runSurfaceLoop({
  page,
  surfaces,
  theme,
  viewport,
  outDir,
  visited = 0,
  total = surfaces.length,
  evalChecks = runChecks,
  onCaptured,
}) {
  const results = [];
  for (const surface of surfaces) {
    if (surface.minWidth && viewport.width < surface.minWidth) continue;
    visited++;
    const name = `${surface.key}--${theme}--${viewport.name}`;
    const screenshotPath = path.join(outDir, `${name}.png`);
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

      const checks = await evalChecks(page);
      record.findings = checks.findings;
      record.hasH1 = checks.hasH1;
      record.sidebarWidth = checks.sidebarWidth;

      const consoleState = page.consoleSnapshot();
      record.consoleErrors = consoleState.errors;
      record.consoleWarnings = consoleState.warnings;
      record.exceptions = page.exceptionsSnapshot();
      const hydrationWarnings = [...consoleState.errors, ...consoleState.warnings].filter((m) =>
        /hydrat/i.test(m),
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
      if (error instanceof CdpConnectionError) throw error;
      record.note = `error: ${error instanceof Error ? error.message : String(error)}`;
      try {
        await page.screenshot(screenshotPath);
      } catch (screenshotError) {
        if (screenshotError instanceof CdpConnectionError) throw screenshotError;
        record.screenshot = null;
      }
    }

    results.push(record);
    onCaptured?.(visited, total, record);
  }
  return { results, visited };
}

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

    const { surfaces, missing } = buildSurfaces(ids, { baseUrl: BASE_URL, locale: LOCALE });
    if (missing.length) {
      notes.push(
        `Could not discover: ${missing.join(", ")} — surfaces depending on them were skipped.`,
      );
    }

    let visited = 0;
    const total = surfaces.reduce(
      (sum, surface) =>
        sum +
        THEMES.length *
          VIEWPORTS.filter((viewport) => !surface.minWidth || viewport.width >= surface.minWidth)
            .length,
      0,
    );

    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        await page.setViewport(viewport.width, viewport.height);
        await page.setTheme(theme);

        const pass = await runSurfaceLoop({
          page,
          surfaces,
          theme,
          viewport,
          outDir: OUT_DIR,
          visited,
          total,
          onCaptured: (done, count, record) => {
            if (done % 10 === 0 || done === count) {
              console.log(
                `  ${done}/${count} captured (${record.surface} · ${theme} · ${viewport.name})`,
              );
            }
          },
        });
        results.push(...pass.results);
        visited = pass.visited;
      }
    }

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
        const opened =
          (await page.clickText("^New$", { within: "[data-chat-list]" })) &&
          (await page.clickText("^Create channel$"));
        if (!opened) record.note = "could not find the Create channel trigger";
        await page.setViewport(1920, 900);
        await sleep(400);
        const checks = await runChecks(page);
        record.findings = checks.findings;
        record.hasH1 = checks.hasH1;
        await page.screenshot(path.join(OUT_DIR, `${name}.png`));
        await page.pressEscape();
      } catch (error) {
        if (error instanceof CdpConnectionError) throw error;
        record.note = `error: ${error instanceof Error ? error.message : String(error)}`;
      }
      results.push(record);

      function url_messages() {
        return `${BASE_URL}/${LOCALE}/w/${ids.workspaceSlug}`;
      }
    }

    await writeReports(results, notes);
    printSummary(results);
    if (process.env.UI_SWEEP_STRICT === "1") {
      const failures = results.filter(
        (r) => r.findings.length || r.exceptions.length || r.consoleErrors.length,
      ).length;
      if (failures) {
        console.error(`UI sweep: ${failures} capture(s) with findings; see findings.md`);
        process.exitCode = 1;
      }
      if (missing.length) {
        console.error(`UI sweep: skipped surfaces needing ${missing.join(", ")}`);
        process.exitCode = 1;
      }
    }

    ws.close();
  } finally {
    chromeProcess.kill("SIGKILL");
  }
}

if (import.meta.main) await main();
