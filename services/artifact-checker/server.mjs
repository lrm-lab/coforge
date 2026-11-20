import { chmodSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { createPlaywrightDriver } from "./browser.mjs";
import { isValidArtifactOrigin } from "./ssrf.mjs";

const DEFAULT_PORT = 3100;
const DEFAULT_MAX_CONCURRENCY = 1;
const DEFAULT_MAX_BODY_BYTES = 24 * 1024 * 1024;
const MAX_QUEUED_REQUESTS = 8;

function rssMb() {
  return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
}

function defaultLogger() {
  return {
    info: (payload) => console.info(JSON.stringify(payload)),
    warn: (payload) => console.warn(JSON.stringify(payload)),
    error: (payload) => console.error(JSON.stringify(payload)),
  };
}

export function isAuthorizedBearer(headerValue, expectedSecret, options = {}) {
  if (!expectedSecret) return Boolean(options.allowUnauthenticated);
  if (typeof headerValue !== "string" || !headerValue.startsWith("Bearer ")) return false;
  const presented = Buffer.from(headerValue.slice(7).trim(), "utf8");
  const expected = Buffer.from(expectedSecret, "utf8");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readJsonBody(req, maxBytes) {
  const declared = Number.parseInt(req.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    const error = new Error("Payload too large");
    error.statusCode = 413;
    throw error;
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    const error = new Error("Payload too large");
    error.statusCode = 413;
    throw error;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    const error = new Error("Invalid JSON body");
    error.statusCode = 400;
    throw error;
  }
}

export function createCheckerServer(options = {}) {
  const secret = options.secret ?? process.env.COFORGE_ARTIFACT_CHECK_SECRET?.trim() ?? "";
  const allowUnauthenticated =
    options.allowUnauthenticated ??
    (process.env.NODE_ENV !== "production" && process.env.CHECKER_ALLOW_UNAUTHENTICATED === "1");
  const maxConcurrency = Math.max(
    1,
    Math.min(
      4,
      Number.parseInt(
        String(
          options.maxConcurrency ??
            process.env.CHECKER_MAX_CONCURRENCY ??
            DEFAULT_MAX_CONCURRENCY,
        ),
        10,
      ) || DEFAULT_MAX_CONCURRENCY,
    ),
  );
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const logger = options.logger ?? defaultLogger();
  const driver =
    options.driver ??
    createPlaywrightDriver({
      proxy: options.proxy,
      idleCloseMs: Number.parseInt(process.env.CHECKER_IDLE_CLOSE_MS ?? "60000", 10) || 60_000,
      logger,
    });

  const startedAt = Date.now();
  let activeJobs = 0;
  const waiters = [];

  async function acquireSlot(signal) {
    if (signal?.aborted) return "aborted";
    if (activeJobs < maxConcurrency) {
      activeJobs += 1;
      return "acquired";
    }
    if (waiters.length >= MAX_QUEUED_REQUESTS) return "full";
    return new Promise((resolve) => {
      const entry = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          activeJobs += 1;
          resolve("acquired");
        },
      };
      const onAbort = () => {
        const index = waiters.indexOf(entry);
        if (index >= 0) waiters.splice(index, 1);
        resolve("aborted");
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.push(entry);
    });
  }

  function releaseSlot() {
    activeJobs = Math.max(0, activeJobs - 1);
    const next = waiters.shift();
    if (next) next.resolve();
  }

  async function handleRequest(req, server) {
    const pathname = new URL(req.url).pathname;
    if (req.method === "GET" && pathname === "/health") {
      return jsonResponse(200, {
        ok: true,
        status: "ready",
        activeJobs,
        queuedJobs: waiters.length,
        maxConcurrency,
        browserActive: driver.isBrowserActive(),
        rssMb: rssMb(),
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      });
    }

    if (req.method !== "POST" || pathname !== "/check") {
      return jsonResponse(404, { error: "Not found" });
    }

    if (!isAuthorizedBearer(req.headers.get("authorization") ?? undefined, secret, { allowUnauthenticated })) {
      const remoteAddress = server?.requestIP?.(req)?.address ?? null;
      logger.warn({
        event: "artifact_checker.auth_rejected",
        remoteAddress,
      });
      return jsonResponse(401, { error: "Unauthorized" });
    }

    const declaredLength = Number.parseInt(req.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      return jsonResponse(413, { error: "Payload too large" });
    }

    const slotState = await acquireSlot(req.signal);
    if (slotState === "full") {
      logger.warn({
        event: "artifact_checker.queue_full",
        activeJobs,
        queuedJobs: waiters.length,
      });
      return jsonResponse(503, { error: "Checker busy" });
    }
    if (slotState === "aborted") return new Response(null, { status: 499 });

    const controller = new AbortController();
    const onRequestAbort = () => controller.abort();
    req.signal.addEventListener("abort", onRequestAbort, { once: true });
    let timer;
    try {
      let payload;
      try {
        payload = await readJsonBody(req, maxBodyBytes);
      } catch (error) {
        return jsonResponse(error.statusCode || 400, { error: error.message });
      }

      if (
        !payload ||
        typeof payload !== "object" ||
        !isValidArtifactOrigin(payload.origin) ||
        !Array.isArray(payload.files)
      ) {
        return jsonResponse(400, { error: "Invalid or missing required fields: origin, files" });
      }

      const jobStart = Date.now();
      const timeoutMs = Math.max(5_000, Math.min(120_000, Number(payload.timeoutMs) || 45_000));
      logger.info({
        event: "artifact_checker.job_started",
        checkId: payload.checkId ?? null,
        artifactId: payload.artifactId ?? null,
        version: payload.version ?? null,
        fileCount: payload.files.length,
        activeJobs,
        rssMb: rssMb(),
      });

      const jobPromise = driver.runCheck(payload, { signal: controller.signal });
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const err = new Error(`Check timed out after ${timeoutMs}ms`);
          err.statusCode = 408;
          reject(err);
        }, timeoutMs);
      });

      try {
        const result = await Promise.race([jobPromise, timeoutPromise]);
        const durationMs = Date.now() - jobStart;
        logger.info({
          event: "artifact_checker.job_completed",
          checkId: payload.checkId ?? null,
          artifactId: payload.artifactId ?? null,
          version: payload.version ?? null,
          durationMs,
          shotCount: Array.isArray(result.screenshots) ? result.screenshots.length : 0,
          consoleErrorCount: result.findings?.consoleErrors?.length ?? 0,
          blockedCount: result.findings?.blockedResources?.length ?? 0,
          brokenImageCount: result.findings?.brokenImages?.length ?? 0,
          failedAssetCount: result.findings?.failedAssets?.length ?? 0,
          scrollLockCount: result.findings?.pageCantScroll?.length ?? 0,
          phoneOverflow: Boolean(result.findings?.phoneOverflow),
          inlineClipped: Boolean(result.findings?.inlineOverflow?.clipped),
          blank: Boolean(result.findings?.blank),
          rssMb: rssMb(),
        });
        return jsonResponse(200, result);
      } catch (error) {
        controller.abort();
        await Promise.race([
          jobPromise.catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 3_500)),
        ]);
        const durationMs = Date.now() - jobStart;
        const status = error.statusCode || 500;
        logger.error({
          event: "artifact_checker.job_failed",
          checkId: payload.checkId ?? null,
          artifactId: payload.artifactId ?? null,
          version: payload.version ?? null,
          status,
          durationMs,
          detail:
            error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
          rssMb: rssMb(),
        });
        return jsonResponse(status, {
          error: error instanceof Error ? error.message : "Check failed",
        });
      }
    } finally {
      req.signal.removeEventListener("abort", onRequestAbort);
      clearTimeout(timer);
      releaseSlot();
    }
  }

  function start(listenOptions = {}) {
    const port = listenOptions.port ?? DEFAULT_PORT;
    const hostname = listenOptions.hostname ?? "0.0.0.0";
    if (listenOptions.socket) {
      const server = Bun.serve({
        unix: listenOptions.socket,
        maxRequestBodySize: maxBodyBytes,
        fetch(request, listener) {
          listener.timeout(request, 130);
          return handleRequest(request);
        },
      });
      chmodSync(listenOptions.socket, 0o660);
      return server;
    }
    return Bun.serve({
      hostname, port, maxRequestBodySize: maxBodyBytes, idleTimeout: 130, fetch: handleRequest,
    });
  }

  return { start, fetch: handleRequest, driver };
}

if (import.meta.main) {
  const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10) || DEFAULT_PORT;
  const hostname = process.env.HOST ?? "127.0.0.1";
  const socket = process.env.COFORGE_ARTIFACT_CHECK_WORKER_SOCKET;
  const proxy = process.env.COFORGE_ARTIFACT_CHECK_EGRESS_PROXY;
  const proxyUrl = proxy ? URL.parse(proxy) : null;
  const secret = process.env.COFORGE_ARTIFACT_CHECK_SECRET?.trim() ?? "";
  const allowUnauthenticated =
    process.env.NODE_ENV !== "production" && process.env.CHECKER_ALLOW_UNAUTHENTICATED === "1";
  const logger = defaultLogger();
  if (!secret && !allowUnauthenticated) {
    logger.error({
      event: "artifact_checker.missing_secret",
      detail:
        "COFORGE_ARTIFACT_CHECK_SECRET is required unless CHECKER_ALLOW_UNAUTHENTICATED=1 in non-production",
    });
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production" &&
      (!socket?.startsWith("/") || proxyUrl?.protocol !== "http:" || proxyUrl.origin !== proxy)) {
    throw new Error("The checker requires a private socket and an HTTP egress proxy");
  }
  const checker = createCheckerServer({ logger, secret, allowUnauthenticated, proxy });
  const server = checker.start({ hostname, port, socket });
  logger.info({
    event: "artifact_checker.started",
    transport: socket ? "unix" : "http",
    ...(!socket ? { host: hostname, port: server.port } : {}),
    authEnabled: Boolean(secret),
    rssMb: rssMb(),
  });
  const shutdown = async () => {
    server.stop();
    await checker.driver.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
