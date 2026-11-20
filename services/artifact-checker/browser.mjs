import { lookup } from "node:dns/promises";
import {
  buildInlineHostHtml,
  clampInlineHeight,
  collectDomDiagnosticsInPage,
  INLINE_HOST_ORIGIN,
  INLINE_HOST_PATH,
  INLINE_MAX_HEIGHT_PX,
} from "./evaluate.mjs";
import {
  isAllowedRequestUrl,
  isPublicIpAddress,
  normalizeBundlePath,
} from "./ssrf.mjs";

const DEFAULT_IDLE_CLOSE_MS = 60_000;
const PAGE_RUNTIME_PATH = "/_coforge/runtime.js";
const SETTLE_MS = 450;
const MAX_CDN_REDIRECTS = 3;
const MAX_CDN_RESPONSE_BYTES = 10 * 1024 * 1024;
const CDN_FETCH_TIMEOUT_MS = 10_000;
const SUBRESOURCE_CSP = "sandbox; default-src 'none'";

function rssMb() {
  return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
}

function clampDim(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(200, Math.min(2560, Math.round(n)));
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function resolvePublicHost(hostname) {
  const records = await lookup(hostname, { all: true });
  if (!Array.isArray(records) || records.length === 0) return false;
  return records.every((rec) => isPublicIpAddress(rec.address));
}

async function fetchCdnSafely(rawUrl, options) {
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= MAX_CDN_REDIRECTS; hop += 1) {
    const verdict = isAllowedRequestUrl(currentUrl, options);
    if (!verdict.allowed || verdict.kind !== "cdn") {
      return { ok: false, blockedUrl: currentUrl };
    }
    const isPublic = await resolvePublicHost(verdict.hostname).catch(() => false);
    if (!isPublic) {
      return { ok: false, blockedUrl: currentUrl };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CDN_FETCH_TIMEOUT_MS);
    const onOuterAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onOuterAbort, { once: true });
    let response;
    try {
      response = await fetch(currentUrl, {
        method: options.method === "HEAD" ? "HEAD" : "GET",
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onOuterAbort);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || hop === MAX_CDN_REDIRECTS) {
        return { ok: false, blockedUrl: location || currentUrl };
      }
      try {
        currentUrl = new URL(location, currentUrl).toString();
      } catch {
        return { ok: false, blockedUrl: location };
      }
      continue;
    }

    const declaredLength = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CDN_RESPONSE_BYTES) {
      return { ok: false, blockedUrl: currentUrl };
    }
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > MAX_CDN_RESPONSE_BYTES) {
      return { ok: false, blockedUrl: currentUrl };
    }
    const headers = {};
    const contentType = response.headers.get("content-type");
    if (contentType) headers["content-type"] = contentType;
    const cacheControl = response.headers.get("cache-control");
    if (cacheControl) headers["cache-control"] = cacheControl;
    const acao = response.headers.get("access-control-allow-origin");
    if (acao) headers["access-control-allow-origin"] = acao;
    return { ok: true, status: response.status, headers, body: buf };
  }
  return { ok: false, blockedUrl: currentUrl };
}

export function createPlaywrightDriver(options = {}) {
  const idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
  const logger = options.logger ?? {
    info: (payload) => console.info(JSON.stringify(payload)),
    warn: (payload) => console.warn(JSON.stringify(payload)),
    error: (payload) => console.error(JSON.stringify(payload)),
  };

  let browser = null;
  let launchPromise = null;
  let activeJobs = 0;
  let idleTimer = null;

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function scheduleIdleClose() {
    clearIdleTimer();
    if (activeJobs > 0 || !browser || idleCloseMs <= 0) return;
    idleTimer = setTimeout(async () => {
      idleTimer = null;
      if (activeJobs > 0 || !browser) return;
      const target = browser;
      browser = null;
      try {
        await target.close();
        logger.info({
          event: "artifact_checker.browser_idle_closed",
          idleCloseMs,
          rssMb: rssMb(),
        });
      } catch (error) {
        logger.warn({
          event: "artifact_checker.browser_close_error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }, idleCloseMs);
    idleTimer.unref?.();
  }

  async function ensureBrowser() {
    clearIdleTimer();
    if (browser && browser.isConnected()) return { browser, launched: false };
    if (!launchPromise) {
      launchPromise = (async () => {
        const started = Date.now();
        const { chromium } = await import("playwright-core");
        const instance = await chromium.launch({
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
          ],
        });
        instance.on("disconnected", () => {
          if (browser === instance) browser = null;
        });
        browser = instance;
        logger.info({
          event: "artifact_checker.browser_launched",
          launchMs: Date.now() - started,
          rssMb: rssMb(),
        });
        return instance;
      })().finally(() => {
        launchPromise = null;
      });
    }
    const instance = await launchPromise;
    return { browser: instance, launched: true };
  }

  async function runCheck(payload, runOptions = {}) {
    const signal = runOptions.signal;
    activeJobs += 1;
    clearIdleTimer();
    try {
      if (signal?.aborted) {
        const err = new Error("Check aborted before start");
        err.statusCode = 408;
        throw err;
      }
      const { browser: instance, launched } = await ensureBrowser();
      const fileMap = new Map();
      for (const file of payload.files ?? []) {
        const key = normalizeBundlePath(file.path);
        if (key) {
          fileMap.set(key, {
            contentType: file.contentType || "application/octet-stream",
            body: Buffer.from(file.base64 || "", "base64"),
          });
        }
      }

      const allowedCdnHosts = new Set(
        (payload.allowedCdnHosts ?? []).map((host) => String(host).toLowerCase()),
      );
      const origin = String(payload.origin).replace(/\/+$/, "");
      const hostOrigin = INLINE_HOST_ORIGIN;
      const entryPath = normalizeBundlePath(payload.entryPath || "index.html") || "index.html";
      const entryUrl = `${origin}/${entryPath}`;
      const timeoutMs = Math.max(5_000, Math.min(120_000, Number(payload.timeoutMs) || 45_000));
      const perShotTimeout = Math.max(5_000, Math.floor(timeoutMs / 3));

      const consoleErrors = [];
      const seenErrors = new Set();
      const blockedResources = [];
      const seenBlocked = new Set();
      const pageCantScroll = [];
      const screenshots = [];
      const shotDurationsMs = {};

      let blank = false;
      let phoneOverflow = null;
      let inlineOverflow = null;

      const addConsoleError = (message, source = null, line = null) => {
        if (consoleErrors.length >= 10) return;
        const cleanMsg = String(message ?? "").trim().slice(0, 500);
        if (!cleanMsg) return;
        const key = `${cleanMsg}|${source ?? ""}|${line ?? ""}`;
        if (seenErrors.has(key)) return;
        seenErrors.add(key);
        consoleErrors.push({
          message: cleanMsg,
          source: source ? String(source).slice(0, 300) : null,
          line: typeof line === "number" && Number.isFinite(line) ? line : null,
        });
      };

      const addBlocked = (url) => {
        if (blockedResources.length >= 20) return;
        const clean = String(url ?? "").slice(0, 500);
        if (!clean || seenBlocked.has(clean)) return;
        seenBlocked.add(clean);
        blockedResources.push(clean);
      };

      const viewports =
        Array.isArray(payload.viewports) && payload.viewports.length > 0
          ? payload.viewports
          : [
              { shot: "desktop", width: 1280, height: 800, deviceScaleFactor: 1, mode: "panel" },
              {
                shot: "phone",
                width: 390,
                height: 844,
                deviceScaleFactor: 2,
                mobile: true,
                mode: "panel",
              },
              { shot: "inline", width: 672, height: 800, deviceScaleFactor: 1, mode: "inline" },
            ];

      for (const vp of viewports) {
        if (signal?.aborted) {
          const err = new Error("Check timed out");
          err.statusCode = 408;
          throw err;
        }
        const shotStart = Date.now();
        const width = clampDim(vp.width, 1280);
        const height = clampDim(vp.height, 800);
        const deviceScaleFactor = Math.max(1, Math.min(3, Number(vp.deviceScaleFactor) || 1));
        const isMobile = Boolean(vp.mobile || vp.shot === "phone");

        const context = await instance.newContext({
          viewport: { width, height },
          deviceScaleFactor,
          isMobile,
          hasTouch: isMobile,
          javaScriptEnabled: true,
          bypassCSP: false,
          serviceWorkers: "block",
        });

        const onAbort = () => {
          context.close().catch(() => {});
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        try {
          if (typeof context.routeWebSocket === "function") {
            await context.routeWebSocket("**/*", (ws) => {
              addBlocked(ws.url());
              ws.close();
            });
          }

          await context.route("**/*", async (route) => {
            const url = route.request().url();
            const verdict = isAllowedRequestUrl(url, {
              artifactOrigin: origin,
              hostOrigin,
              allowedCdnHosts,
            });
            if (!verdict.allowed) {
              addBlocked(url);
              await route.abort("blockedbyclient");
              return;
            }
            if (verdict.kind === "internal") {
              await route.continue();
              return;
            }
            if (verdict.kind === "cdn") {
              const fetched = await fetchCdnSafely(url, {
                artifactOrigin: origin,
                hostOrigin,
                allowedCdnHosts,
                method: route.request().method(),
                signal,
              }).catch(() => ({ ok: false, blockedUrl: url }));
              if (!fetched.ok) {
                addBlocked(fetched.blockedUrl || url);
                await route.abort("blockedbyclient");
                return;
              }
              await route.fulfill({
                status: fetched.status,
                headers: fetched.headers,
                body: fetched.body,
              });
              return;
            }
            if (verdict.kind === "host") {
              if (verdict.pathname !== INLINE_HOST_PATH) {
                await route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });
                return;
              }
              await route.fulfill({
                status: 200,
                headers: {
                  "Content-Type": "text/html; charset=utf-8",
                  "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src ${origin}; base-uri 'none'; form-action 'none'; connect-src 'none'`,
                },
                body: buildInlineHostHtml({
                  entryUrl,
                  artifactOrigin: origin,
                  width,
                  maxHeight: INLINE_MAX_HEIGHT_PX,
                }),
              });
              return;
            }

            const pathname = verdict.pathname || "/";
            if (pathname === PAGE_RUNTIME_PATH) {
              await route.fulfill({
                status: 200,
                headers: {
                  "Content-Type": "text/javascript; charset=utf-8",
                  "X-Content-Type-Options": "nosniff",
                },
                body: payload.runtimeJs || "",
              });
              return;
            }
            const normalized = normalizeBundlePath(pathname);
            if (normalized === null) {
              await route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });
              return;
            }
            const rel = normalized === "" ? entryPath : normalized;
            const entry = fileMap.get(rel);
            if (!entry) {
              await route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });
              return;
            }
            const headers = {
              "Content-Type": entry.contentType,
              "X-Content-Type-Options": "nosniff",
            };
            if (entry.contentType.startsWith("text/html")) {
              if (payload.csp) headers["Content-Security-Policy"] = payload.csp;
            } else {
              headers["Content-Security-Policy"] = SUBRESOURCE_CSP;
            }
            await route.fulfill({ status: 200, headers, body: entry.body });
          });

          const page = await context.newPage();
          page.on("pageerror", (error) => {
            addConsoleError(error?.message || String(error), null, null);
          });
          page.on("console", (msg) => {
            if (msg.type() === "error") {
              const loc = msg.location();
              addConsoleError(msg.text(), loc?.url || null, loc?.lineNumber ?? null);
            }
          });

          if (vp.mode === "inline" || vp.shot === "inline") {
            await page.goto(`${hostOrigin}${INLINE_HOST_PATH}`, {
              waitUntil: "load",
              timeout: perShotTimeout,
            });
            await page.waitForTimeout(SETTLE_MS);
            const childFrame = page.frames().find((f) => f !== page.mainFrame());
            if (childFrame) {
              const diag = await withTimeout(
                childFrame.evaluate(collectDomDiagnosticsInPage, {
                  shot: "inline",
                  maxInlineHeight: INLINE_MAX_HEIGHT_PX,
                }),
                perShotTimeout,
                "inline evaluate",
              );
              if (diag.blank) blank = true;
              const reported = await withTimeout(
                page.evaluate(() => window.__coforgeInlineSize),
                perShotTimeout,
                "inline size read",
              );
              const measuredHeight = Math.max(
                diag.inlineOverflow?.contentHeight ?? 0,
                typeof reported === "number" && Number.isFinite(reported)
                  ? Math.round(reported)
                  : 0,
              );
              inlineOverflow = {
                contentHeight: measuredHeight,
                maxHeight: INLINE_MAX_HEIGHT_PX,
                clipped: measuredHeight > INLINE_MAX_HEIGHT_PX,
              };
              const targetHeight = clampInlineHeight(measuredHeight);
              await page.setViewportSize({ width, height: targetHeight });
              await withTimeout(
                page.evaluate((h) => {
                  const el = document.getElementById("artifact-frame");
                  if (el) el.style.height = `${h}px`;
                }, targetHeight),
                perShotTimeout,
                "inline resize",
              );
              await page.waitForTimeout(100);
            }
            const png = await page.screenshot({
              type: "png",
              fullPage: false,
              timeout: perShotTimeout,
            });
            screenshots.push({
              shot: "inline",
              contentType: "image/png",
              base64: png.toString("base64"),
            });
          } else {
            await page.goto(entryUrl, {
              waitUntil: "load",
              timeout: perShotTimeout,
            });
            await page.waitForTimeout(SETTLE_MS);
            const diag = await withTimeout(
              page.evaluate(collectDomDiagnosticsInPage, {
                shot: vp.shot,
                maxInlineHeight: INLINE_MAX_HEIGHT_PX,
              }),
              perShotTimeout,
              `${vp.shot} evaluate`,
            );
            if (vp.shot === "desktop" && diag.blank) blank = true;
            if (vp.shot === "phone" && diag.phoneOverflow) phoneOverflow = diag.phoneOverflow;
            if (diag.scrollLock) pageCantScroll.push(diag.scrollLock);
            const png = await page.screenshot({
              type: "png",
              fullPage: false,
              timeout: perShotTimeout,
            });
            screenshots.push({
              shot: vp.shot,
              contentType: "image/png",
              base64: png.toString("base64"),
            });
          }
        } finally {
          signal?.removeEventListener("abort", onAbort);
          await withTimeout(context.close(), 3_000, "context close").catch(() => {});
          shotDurationsMs[vp.shot] = Date.now() - shotStart;
        }
      }

      return {
        findings: {
          consoleErrors,
          blockedResources,
          blank,
          phoneOverflow,
          inlineOverflow,
          ...(pageCantScroll.length > 0 ? { pageCantScroll } : {}),
        },
        screenshots,
        metrics: {
          shotDurationsMs,
          workerRssMb: rssMb(),
          browserLaunched: launched,
        },
      };
    } finally {
      activeJobs = Math.max(0, activeJobs - 1);
      scheduleIdleClose();
    }
  }

  return {
    runCheck,
    isBrowserActive: () => Boolean(browser && browser.isConnected()),
    close: async () => {
      clearIdleTimer();
      if (browser) {
        const target = browser;
        browser = null;
        await target.close().catch(() => {});
      }
    },
  };
}
