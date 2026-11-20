import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
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

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes) {
  const declared = Number.parseInt(String(req.headers["content-length"] ?? ""), 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    const error = new Error("Payload too large");
    error.statusCode = 413;
    throw error;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("Payload too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
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
      idleCloseMs: Number.parseInt(process.env.CHECKER_IDLE_CLOSE_MS ?? "60000", 10) || 60_000,
      logger,
    });

  const startedAt = Date.now();
  let activeJobs = 0;
  const waiters = [];

  async function acquireSlot(req) {
    if (activeJobs < maxConcurrency) {
      activeJobs += 1;
      return "acquired";
    }
    if (waiters.length >= MAX_QUEUED_REQUESTS) return "full";
    return new Promise((resolve) => {
      const entry = {
        resolve: () => {
          req.off("close", onClose);
          activeJobs += 1;
          resolve("acquired");
        },
      };
      const onClose = () => {
        const index = waiters.indexOf(entry);
        if (index >= 0) waiters.splice(index, 1);
        resolve("aborted");
      };
      req.once("close", onClose);
      waiters.push(entry);
    });
  }

  function releaseSlot() {
    activeJobs = Math.max(0, activeJobs - 1);
    const next = waiters.shift();
    if (next) next.resolve();
  }

  const server = createServer(async (req, res) => {
    const url = req.url || "/";
    if (req.method === "GET" && url === "/health") {
      sendJson(res, 200, {
        ok: true,
        status: "ready",
        activeJobs,
        queuedJobs: waiters.length,
        maxConcurrency,
        browserActive: driver.isBrowserActive(),
        rssMb: rssMb(),
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      });
      return;
    }

    if (req.method !== "POST" || url !== "/check") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    if (!isAuthorizedBearer(req.headers.authorization, secret, { allowUnauthenticated })) {
      logger.warn({
        event: "artifact_checker.auth_rejected",
        remoteAddress: req.socket.remoteAddress ?? null,
      });
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const declaredLength = Number.parseInt(String(req.headers["content-length"] ?? ""), 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      sendJson(res, 413, { error: "Payload too large" });
      return;
    }

    const slotState = await acquireSlot(req);
    if (slotState === "full") {
      logger.warn({
        event: "artifact_checker.queue_full",
        activeJobs,
        queuedJobs: waiters.length,
      });
      sendJson(res, 503, { error: "Checker busy" });
      return;
    }
    if (slotState === "aborted") return;

    const controller = new AbortController();
    const onResponseClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", onResponseClose);
    let timer;
    try {
      let payload;
      try {
        payload = await readJsonBody(req, maxBodyBytes);
      } catch (error) {
        sendJson(res, error.statusCode || 400, { error: error.message });
        return;
      }

      if (
        !payload ||
        typeof payload !== "object" ||
        !isValidArtifactOrigin(payload.origin) ||
        !Array.isArray(payload.files)
      ) {
        sendJson(res, 400, { error: "Invalid or missing required fields: origin, files" });
        return;
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
        sendJson(res, 200, result);
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
        sendJson(res, status, { error: error instanceof Error ? error.message : "Check failed" });
      }
    } finally {
      res.off("close", onResponseClose);
      clearTimeout(timer);
      releaseSlot();
    }
  });

  return { server, driver };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10) || DEFAULT_PORT;
  const host = process.env.HOST ?? "0.0.0.0";
  const secret = process.env.COFORGE_ARTIFACT_CHECK_SECRET?.trim() ?? "";
  const allowUnauthenticated =
    process.env.NODE_ENV !== "production" && process.env.CHECKER_ALLOW_UNAUTHENTICATED === "1";
  const logger = defaultLogger();
  if (!secret && !allowUnauthenticated) {
    logger.error({
      event: "artifact_checker.missing_secret",
      detail: "COFORGE_ARTIFACT_CHECK_SECRET is required unless CHECKER_ALLOW_UNAUTHENTICATED=1 in non-production",
    });
    process.exit(1);
  }
  const { server, driver } = createCheckerServer({ logger, secret, allowUnauthenticated });
  server.listen(port, host, () => {
    logger.info({
      event: "artifact_checker.started",
      host,
      port,
      authEnabled: Boolean(secret),
      rssMb: rssMb(),
    });
  });
  const shutdown = async () => {
    server.close();
    await driver.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
