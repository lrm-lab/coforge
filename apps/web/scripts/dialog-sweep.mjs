#!/usr/bin/env bun
// Opens each of the app's dialogs in a running dev server and saves a screenshot of every one, so
// the button rows of two builds can be compared dialog by dialog (task #224: every dialog footer
// moves to the shared `DialogActions` row). Run it once against each server with the same output
// layout: the file names depend only on the dialog ids below, never on the server or its data.
//
// Run from the repository root with `bun run --cwd apps/web dialog:sweep`. It needs a dev server
// whose database holds the dev seed (`bun run seed:dev`) and signs in the dev user.
//
// Per dialog the output directory gets `<id>.png` (the dialog's surface) and `<id>-page.png` (the
// 1440x900 light viewport), plus one `report.json` mapping each id to `ok` or `failed: <reason>`
// and one `buttons.json` with the height of every labelled button in each dialog.
// A dialog the seed cannot reach is reported as failed with the reason; it never stops the run.
// Nothing is ever confirmed: each dialog is opened, captured and closed with Escape.
//
// It drives a locally launched Chromium over the raw Chrome DevTools Protocol, like `ui-sweep.mjs`
// (shared plumbing in `cdp-browser.mjs`).
//
// Env vars:
//   DIALOG_SWEEP_BASE         base URL of the running dev server (default http://127.0.0.1:8788)
//   DIALOG_SWEEP_OUT          output directory (default ./sweep/dialogs in the working directory)
//   DIALOG_SWEEP_CHROME_PATH  explicit path to a Chromium/Chrome binary (else UI_SWEEP_CHROME_PATH,
//                             else auto-detected)
//   DIALOG_SWEEP_LOCALE       locale path prefix (default "en")
//   DIALOG_SWEEP_ONLY         comma-separated dialog ids to run (default all)

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { findChrome, launchChrome, connectPage, pageCtx, sleep } from "./cdp-browser.mjs";
import { DIALOGS } from "./dialog-sweep-cases.mjs";

const BASE_URL = (process.env.DIALOG_SWEEP_BASE ?? "http://127.0.0.1:8788").replace(/\/$/, "");
const LOCALE = process.env.DIALOG_SWEEP_LOCALE ?? "en";
const OUT_DIR = process.env.DIALOG_SWEEP_OUT ?? path.join(process.cwd(), "sweep", "dialogs");
const ONLY = process.env.DIALOG_SWEEP_ONLY?.split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const VIEWPORT = { width: 1440, height: 900 };
const STEP_TIMEOUT_MS = 8_000;
const SETTLE_TIMEOUT_MS = 3_000;
const DIALOG_TIMEOUT_MS = 8_000;
// A page that stops answering must cost one dialog, not the run.
const WATCHDOG_MS = 90_000;

// ---------------------------------------------------------------------------
const PAGE_HELPERS = `
  const MODAL_SELECTOR = '[role="dialog"]:not([data-trigger]), [role="alertdialog"]';
  const IMPLICIT_ROLES = {
    button: "button", a: "link", textarea: "textbox", select: "combobox", summary: "button",
  };

  function sweepVisible(el) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    // A visually hidden control (screen-reader-only) is 1px wide.
    return rect.width > 1 && rect.height > 1;
  }

  function sweepRole(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    if (el.tagName === "INPUT") {
      const type = el.getAttribute("type") || "text";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "button" || type === "submit") return "button";
      return "textbox";
    }
    return IMPLICIT_ROLES[el.tagName.toLowerCase()] || "";
  }

  function sweepName(el) {
    const label = el.getAttribute("aria-label");
    if (label) return label.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
        .trim();
      if (text) return text;
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const fieldLabel = el.id ? document.querySelector('label[for="' + el.id + '"]') : null;
      return ((fieldLabel && fieldLabel.textContent) || el.placeholder || "").trim();
    }
    return (el.textContent || "").replace(/\\s+/g, " ").trim();
  }

  function sweepModals() {
    return [...document.querySelectorAll(MODAL_SELECTOR)].filter(sweepVisible);
  }

  function sweepFind(role, name, inDialog) {
    const pattern = new RegExp(name, "i");
    let roots = [document];
    if (inDialog) {
      const modals = sweepModals();
      if (!modals.length) return null;
      roots = [modals[modals.length - 1]];
    }
    for (const root of roots) {
      for (const el of root.querySelectorAll("*")) {
        const elRole = sweepRole(el);
        const matches = role === "menuitem" ? elRole.startsWith("menuitem") : elRole === role;
        if (matches && sweepVisible(el) && pattern.test(sweepName(el))) return el;
      }
    }
    return null;
  }
`;

const findRect = (role, name, inDialog) => `(() => {
  ${PAGE_HELPERS}
  const el = sweepFind(${JSON.stringify(role)}, ${JSON.stringify(name)}, ${inDialog});
  // Server-rendered markup answers no click until React hydrates it and attaches its handlers.
  if (!el || !Object.keys(el).some((key) => key.startsWith("__reactProps$"))) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

/** The surface of the dialog whose text matches `expect`: the dialog's outermost ancestor that
 * does not fill the viewport (the modal that carries the border, radius and shadow). */
const findDialogRect = (expect) => `(() => {
  ${PAGE_HELPERS}
  const pattern = ${expect ? `new RegExp(${JSON.stringify(expect)}, "i")` : "null"};
  const matching = sweepModals().filter((el) => !pattern || pattern.test(el.innerText || ""));
  const dialog = matching[matching.length - 1];
  if (!dialog) return null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let surface = dialog;
  while (surface.parentElement && surface.parentElement !== document.body) {
    const r = surface.parentElement.getBoundingClientRect();
    if (r.width >= vw - 1 && r.height >= vh - 1) break;
    surface = surface.parentElement;
  }
  const r = surface.getBoundingClientRect();
  const left = Math.max(0, r.left);
  const top = Math.max(0, r.top);
  return {
    x: left,
    y: top,
    width: Math.min(vw, r.right) - left,
    height: Math.min(vh, r.bottom) - top,
    animating: surface.getAnimations({ subtree: true }).some((a) => a.playState === "running"),
    // The first line of the dialog, to tell what opened if the wrong dialog did.
    title: (dialog.innerText || "").trim().slice(0, 60).replace(/\\s+/g, " "),
  };
})()`;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function poll(read, timeoutMs, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
}

/** Waits until the page stops loading: no new resource, and the text no longer changes. A click
 * before that can land on a component that data arriving later remounts, closing its dialog. */
async function settlePage(page) {
  let last = "";
  let stableFor = 0;
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (stableFor < 4 && Date.now() < deadline) {
    await sleep(250);
    const now = await page.evalJs(
      `document.readyState + performance.getEntriesByType("resource").length + document.body.innerText.length`,
    );
    stableFor = now === last ? stableFor + 1 : 0;
    last = now;
  }
}

async function runStep(page, step, workspacePath) {
  const describe = () => `${step.role} /${step.name}/${step.inDialog ? " in the open dialog" : ""}`;
  switch (step.kind) {
    case "goto":
      await page.navigate(`${BASE_URL}${workspacePath}${step.target}`);
      await settlePage(page);
      return;
    case "follow": {
      const href = await poll(
        () =>
          page.evalJs(`(() => {
            ${PAGE_HELPERS}
            return sweepFind("link", ${JSON.stringify(step.name)}, false)?.href ?? null;
          })()`),
        STEP_TIMEOUT_MS,
      );
      if (!href) throw new Error(`no link /${step.name}/`);
      await page.navigate(href);
      await settlePage(page);
      return;
    }
    case "click": {
      const rect = await poll(
        () => page.evalJs(findRect(step.role, step.name, step.inDialog)),
        STEP_TIMEOUT_MS,
      );
      if (!rect) throw new Error(`no ${describe()}`);
      await page.clickRect(rect);
      await sleep(350);
      return;
    }
    case "activate": {
      const found = await poll(
        () =>
          page.evalJs(`(() => {
            ${PAGE_HELPERS}
            const el = sweepFind(${JSON.stringify(step.role)}, ${JSON.stringify(step.name)}, false);
            if (!el) return false;
            el.focus();
            return true;
          })()`),
        STEP_TIMEOUT_MS,
      );
      if (!found) throw new Error(`no ${describe()}`);
      await page.pressKey("Enter");
      await sleep(350);
      return;
    }
    case "fill": {
      const rect = await poll(
        () => page.evalJs(findRect(step.role, step.name, true)),
        STEP_TIMEOUT_MS,
      );
      if (!rect) throw new Error(`no ${describe()}`);
      await page.clickRect(rect);
      await page.insertText(step.text);
      await sleep(250);
      return;
    }
    case "press":
      if (step.key !== "Escape") await page.pressKey(step.key);
      else await page.pressEscape();
      await sleep(500);
      return;
    case "wait": {
      const rect = await poll(
        () => page.evalJs(findRect(step.role, step.name, step.inDialog)),
        STEP_TIMEOUT_MS,
      );
      if (!rect) throw new Error(`no ${describe()}`);
      return;
    }
  }
}

async function captureDialog(page, dialog) {
  const rect = await poll(() => page.evalJs(findDialogRect(dialog.expect)), DIALOG_TIMEOUT_MS);
  if (!rect) {
    const open = await page.evalJs(
      `(() => { ${PAGE_HELPERS} return sweepModals().map((el) => (el.innerText || "").trim().slice(0, 40).replace(/\\s+/g, " ")); })()`,
    );
    throw new Error(
      open.length
        ? `opened ${open.map((text) => `"${text}"`).join(", ")} instead of a dialog matching /${dialog.expect}/`
        : "no dialog opened",
    );
  }
  // Settle: fonts, entry animations, the caret, then a stable box.
  await page.evalJs(`(async () => {
    await document.fonts.ready;
    const style = document.createElement("style");
    style.textContent = "* { caret-color: transparent !important; }";
    document.head.append(style);
  })()`);
  await page.mouseMove(0, 0);
  let current = rect;
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(150);
    const next = await page.evalJs(findDialogRect(dialog.expect));
    if (!next) throw new Error("the dialog closed while settling");
    const stable =
      !next.animating &&
      ["x", "y", "width", "height"].every((key) => Math.abs(next[key] - current[key]) < 0.5);
    current = next;
    if (stable) break;
  }
  await sleep(150);
  const { x, y, width, height } = current;
  await page.screenshot(path.join(OUT_DIR, `${dialog.id}.png`), {
    x,
    y,
    width,
    height,
  });
  await page.screenshot(path.join(OUT_DIR, `${dialog.id}-page.png`));
  buttonSizes[dialog.id] = await page.evalJs(MEASURE_BUTTONS);
}

// Every labelled button of the dialog on top: its name and rendered height, so `buttons.json` shows
// which dialogs mix sizes or leave the shared 40px row (task #224's acceptance measured 36 vs 40).
const buttonSizes = {};
const MEASURE_BUTTONS = `(() => {
  ${PAGE_HELPERS}
  const modal = sweepModals().at(-1);
  if (!modal) return [];
  return [...modal.querySelectorAll("button, a[href]")]
    .filter((el) => sweepVisible(el) && (el.innerText || "").trim())
    .map((el) => ({
      name: (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40),
      height: Math.round(el.getBoundingClientRect().height),
    }));
})()`;

async function closeDialogs(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const open = await page.evalJs(`(() => { ${PAGE_HELPERS} return sweepModals().length; })()`);
    if (!open) return;
    await page.pressEscape();
    await sleep(300);
  }
}

async function attemptDialog(page, dialog, workspacePath) {
  let where = "navigating";
  const work = (async () => {
    try {
      await page.navigate(`${BASE_URL}${workspacePath}`);
      for (const step of dialog.steps) {
        where = `step ${step.kind} ${step.role ?? step.target ?? step.key ?? ""}`;
        await runStep(page, step, workspacePath);
      }
      where = "capturing";
      await captureDialog(page, dialog);
      return "ok";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      where = "closing";
      await closeDialogs(page).catch(() => undefined);
    }
  })();
  let timer;
  const watchdog = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve(`the page stopped responding for ${WATCHDOG_MS / 1000}s while ${where}`),
      WATCHDOG_MS,
    );
  });
  try {
    return await Promise.race([work, watchdog]);
  } finally {
    clearTimeout(timer);
  }
}

async function runDialog(page, dialog, workspacePath) {
  let result = await attemptDialog(page, dialog, workspacePath);
  // A dev server compiles routes on first use, which can outlast a step's wait; a dialog the seed
  // cannot reach fails the same way twice, so only the others earn the second attempt.
  if (result !== "ok" && !dialog.unreachable)
    result = await attemptDialog(page, dialog, workspacePath);
  if (result === "ok") return result;
  return dialog.unreachable ? `failed: ${dialog.unreachable} (${result})` : `failed: ${result}`;
}

async function main() {
  const known = new Set(DIALOGS.map((dialog) => dialog.id));
  const unknown = (ONLY ?? []).filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Unknown dialog id(s) in DIALOG_SWEEP_ONLY: ${unknown}`);
  const selected = DIALOGS.filter((dialog) => !ONLY || ONLY.includes(dialog.id));

  await mkdir(OUT_DIR, { recursive: true });
  const chromePath = await findChrome(["DIALOG_SWEEP_CHROME_PATH", "UI_SWEEP_CHROME_PATH"]);
  console.log(`Using Chromium at: ${chromePath}`);
  const port = 9833 + (process.pid % 100);
  const chrome = await launchChrome(chromePath, port, "dialog-sweep-chrome-");
  const report = {};

  try {
    const { cdp, sessionId, ws } = await connectPage(port);
    const page = pageCtx(cdp, sessionId);
    await page.setViewport(VIEWPORT.width, VIEWPORT.height);
    await page.setTheme("light");

    console.log(`Base URL: ${BASE_URL}`);
    // The app root opens the signed-in user's Workspace; every page lives under `/w/<slug>`.
    await page.navigate(`${BASE_URL}/${LOCALE}`);
    const slug = await page.evalJs(
      `location.pathname.match(new RegExp(${JSON.stringify(`^/${LOCALE}/w/([^/?#]+)`)}))?.[1] ?? null`,
    );
    if (!slug)
      throw new Error(
        "Could not discover the Workspace slug: the app root did not open a Workspace (is the dev user signed in with a seeded Workspace?)",
      );
    const workspacePath = `/${LOCALE}/w/${slug}`;

    for (const dialog of selected) {
      report[dialog.id] = await runDialog(page, dialog, workspacePath);
      console.log(`${dialog.id.padEnd(32)} ${report[dialog.id]}`);
    }
    ws.close();
  } finally {
    chrome.kill();
    await sleep(300);
    await rm(chrome.profileDir, { recursive: true, force: true });
  }

  await writeFile(path.join(OUT_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(OUT_DIR, "buttons.json"), `${JSON.stringify(buttonSizes, null, 2)}\n`);
  for (const [id, buttons] of Object.entries(buttonSizes)) {
    const off = buttons.filter((button) => button.height !== 40);
    if (off.length)
      console.log(
        `${id.padEnd(32)} not 40px: ${off.map((b) => `${b.name} ${b.height}`).join(", ")}`,
      );
  }
  const failed = Object.values(report).filter((status) => status !== "ok").length;
  console.log(`\n${selected.length - failed} ok, ${failed} failed. Output: ${OUT_DIR}`);
}

if (import.meta.main) await main();
