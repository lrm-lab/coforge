// Shared Chromium-over-CDP plumbing for the browser sweeps (`ui-sweep.mjs`,
// `dialog-sweep.mjs`): locate and launch a Chromium binary with
// `--remote-debugging-port`, a minimal CDP client, and a page context with
// navigation, input and screenshot helpers. No dependency beyond a local
// Chromium binary.

import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Chromium discovery + launch
// ---------------------------------------------------------------------------
export async function findChrome(envVars = ["UI_SWEEP_CHROME_PATH"]) {
  for (const name of envVars) {
    const explicit = process.env[name];
    if (explicit && existsSync(explicit)) return explicit;
  }

  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;

  // Playwright's Chrome-for-Testing cache, if this machine has it (common in
  // dev environments that already use Playwright for something else).
  const playwrightDir = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  const found = await findUnder(playwrightDir, (name) => name === "Google Chrome for Testing");
  if (found) return found;
  const linuxPlaywrightDir = path.join(os.homedir(), ".cache", "ms-playwright");
  const foundLinux = await findUnder(linuxPlaywrightDir, (name) => name === "chrome");
  if (foundLinux) return foundLinux;

  // Puppeteer's cache.
  const puppeteerDir = path.join(os.homedir(), ".cache", "puppeteer");
  const foundPuppeteer = await findUnder(
    puppeteerDir,
    (name) => name === "Google Chrome for Testing" || name === "chrome",
  );
  if (foundPuppeteer) return foundPuppeteer;

  throw new Error(
    `No Chromium binary found. Set ${envVars[0]} to a Chrome/Chromium executable ` +
      "(e.g. the one under ~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/… on macOS).",
  );
}

async function findUnder(root, matchName, depth = 6) {
  if (!existsSync(root) || depth === 0) return null;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && matchName(entry.name)) return full;
    if (entry.isDirectory()) {
      const nested = await findUnder(full, matchName, depth - 1);
      if (nested) return nested;
    }
  }
  return null;
}

export async function launchChrome(chromePath, port, profilePrefix = "ui-sweep-chrome-") {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), profilePrefix));
  const child = Bun.spawn(
    [
      chromePath,
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  child.unref();
  child.profileDir = profileDir;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return child;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error("Chromium did not open its DevTools port in time");
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Minimal CDP client (flat sessionId mode) — one browser-level WebSocket,
// one attached page target reused for the whole sweep.
// ---------------------------------------------------------------------------
class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map(); // method -> Set<fn>
    ws.addEventListener("message", (event) => this.onMessage(String(event.data)));
  }

  onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message ?? "CDP error"));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const set = this.listeners.get(msg.method);
      if (set) for (const fn of set) fn(msg.params, msg.sessionId);
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method)?.delete(fn);
  }
}

export async function connectPage(port) {
  const versionRes = await fetch(`http://127.0.0.1:${port}/json/version`);
  const { webSocketDebuggerUrl } = await versionRes.json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const cdp = new CdpClient(ws);
  const { targetId } = await cdp.send("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("DOM.enable", {}, sessionId);
  return { cdp, sessionId, ws };
}

// ---------------------------------------------------------------------------
// Page-level helpers
// ---------------------------------------------------------------------------
export function pageCtx(cdp, sessionId) {
  const console_ = { errors: [], warnings: [] };
  let exceptions = [];
  cdp.on("Runtime.consoleAPICalled", (params, sid) => {
    if (sid !== sessionId) return;
    const text = (params.args ?? [])
      .map((a) => a.value ?? a.description ?? "")
      .join(" ")
      .slice(0, 500);
    if (params.type === "error") console_.errors.push(text);
    else if (params.type === "warning") console_.warnings.push(text);
  });
  cdp.on("Runtime.exceptionThrown", (params, sid) => {
    if (sid !== sessionId) return;
    exceptions.push(
      (
        params.exceptionDetails?.exception?.description ??
        params.exceptionDetails?.text ??
        ""
      ).slice(0, 500),
    );
  });

  function resetConsole() {
    console_.errors = [];
    console_.warnings = [];
    exceptions = [];
  }

  async function evalJs(expression) {
    const result = await cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
    }
    return result.result?.value;
  }

  async function setViewport(width, height) {
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: 1, mobile: width < 500 },
      sessionId,
    );
  }

  async function setTheme(theme) {
    await cdp.send(
      "Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-color-scheme", value: theme }] },
      sessionId,
    );
  }

  async function navigate(url) {
    resetConsole();
    const loaded = new Promise((resolve) => {
      const off = cdp.on("Page.loadEventFired", (_p, sid) => {
        if (sid !== sessionId) return;
        off();
        resolve();
      });
      setTimeout(resolve, 15_000);
    });
    await cdp.send("Page.navigate", { url }, sessionId);
    await loaded;
    // Let the SPA hydrate/settle and any post-load data fetches paint.
    await sleep(700);
  }

  async function rectFor(matcherJsExpr) {
    return evalJs(
      `(() => {
        const el = (${matcherJsExpr});
        if (!el) return null;
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top };
      })()`,
    );
  }

  const FINDER = `
    function ebFindByText(pattern, opts) {
      opts = opts || {};
      const re = new RegExp(pattern, "i");
      const root = opts.within ? document.querySelector(opts.within) : document;
      if (!root) return null;
      const candidates = root.querySelectorAll('button, a, [role="button"], [role="tab"], [tabindex]');
      for (const el of candidates) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
        if (re.test(label)) return el;
      }
      return null;
    }
  `;

  async function findRectByText(pattern, opts) {
    return rectFor(
      `(() => { ${FINDER} return ebFindByText(${JSON.stringify(pattern)}, ${JSON.stringify(opts ?? {})}); })()`,
    );
  }

  async function findRectBySelector(selector) {
    return rectFor(`document.querySelector(${JSON.stringify(selector)})`);
  }

  async function mouseMove(x, y) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
  }
  async function mouseDown(x, y) {
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x, y, button: "left", clickCount: 1 },
      sessionId,
    );
  }
  async function mouseUp(x, y) {
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
      sessionId,
    );
  }

  async function clickRect(rect) {
    await mouseMove(rect.x, rect.y);
    await mouseDown(rect.x, rect.y);
    await mouseUp(rect.x, rect.y);
  }

  async function clickText(pattern, opts) {
    const rect = await findRectByText(pattern, opts);
    if (!rect) return false;
    await clickRect(rect);
    await sleep(350);
    return true;
  }

  async function hoverText(pattern, opts) {
    const rect = await findRectByText(pattern, opts);
    if (!rect) return false;
    await mouseMove(rect.x, rect.y);
    await sleep(450); // HoverPopover / tooltip open delay
    return true;
  }

  async function pressEscape() {
    await cdp.send(
      "Input.dispatchKeyEvent",
      {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      },
      sessionId,
    );
    await cdp.send(
      "Input.dispatchKeyEvent",
      {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      },
      sessionId,
    );
    await sleep(250);
  }

  // `clip` is an optional { x, y, width, height } in CSS pixels; without it the viewport is captured.
  const KEYS = {
    Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
    Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  };

  async function pressKey(name) {
    const def = KEYS[name];
    if (!def) throw new Error(`Unsupported key: ${name}`);
    const { text, ...rest } = def;
    const event = { key: name, ...rest };
    await cdp.send(
      "Input.dispatchKeyEvent",
      {
        type: text ? "keyDown" : "rawKeyDown",
        ...event,
        ...(text ? { text } : {}),
      },
      sessionId,
    );
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...event }, sessionId);
    await sleep(250);
  }

  async function insertText(text) {
    await cdp.send("Input.insertText", { text }, sessionId);
  }

  async function screenshot(filePath, clip) {
    const params = { format: "png" };
    if (clip) params.clip = { ...clip, scale: 1 };
    const { data } = await cdp.send("Page.captureScreenshot", params, sessionId);
    await writeFile(filePath, Buffer.from(data, "base64"));
  }

  return {
    evalJs,
    setViewport,
    setTheme,
    navigate,
    findRectByText,
    findRectBySelector,
    clickRect,
    clickText,
    hoverText,
    mouseMove,
    mouseDown,
    mouseUp,
    pressEscape,
    pressKey,
    insertText,
    screenshot,
    resetConsole,
    consoleSnapshot: () => ({
      errors: [...console_.errors],
      warnings: [...console_.warnings],
    }),
    exceptionsSnapshot: () => [...exceptions],
  };
}
