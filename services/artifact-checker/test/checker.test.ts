import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildInlineHostHtml,
  clampInlineHeight,
  INLINE_HOST_ORIGIN,
  INLINE_LIGHT_TOKENS,
} from "../evaluate.mjs";
import { createCheckerServer, isAuthorizedBearer } from "../server.mjs";
import {
  fetchCdnSafely,
  isAllowedRequestUrl,
  isPublicIpAddress,
  isValidArtifactOrigin,
  normalizeBundlePath,
} from "../ssrf.mjs";

describe("artifact-checker SSRF allowlist", () => {
  const origin = "https://a-1234.coforge.check";
  const cdns = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];

  test("validates synthetic artifact origins and public IP ranges", () => {
    expect(isValidArtifactOrigin(origin)).toBe(true);
    expect(isValidArtifactOrigin("https://evil.example")).toBe(false);
    expect(isValidArtifactOrigin("http://a-1234.coforge.check")).toBe(false);

    expect(isPublicIpAddress("1.1.1.1")).toBe(true);
    expect(isPublicIpAddress("8.8.8.8")).toBe(true);
    expect(isPublicIpAddress("100.100.100.200")).toBe(false);
    expect(isPublicIpAddress("169.254.169.254")).toBe(false);
    expect(isPublicIpAddress("127.0.0.1")).toBe(false);
    expect(isPublicIpAddress("10.0.0.5")).toBe(false);
    expect(isPublicIpAddress("172.16.0.1")).toBe(false);
    expect(isPublicIpAddress("192.168.1.1")).toBe(false);
    expect(isPublicIpAddress("::1")).toBe(false);
    expect(isPublicIpAddress("fe80::1")).toBe(false);
    expect(isPublicIpAddress("::ffff:127.0.0.1")).toBe(false);
  });

  test("allows synthetic artifact origin, separate inline host origin, allowed CDNs, and data/blob URLs", () => {
    expect(
      isAllowedRequestUrl(`${origin}/index.html`, {
        artifactOrigin: origin,
        hostOrigin: INLINE_HOST_ORIGIN,
        allowedCdnHosts: cdns,
      }),
    ).toEqual({
      allowed: true,
      kind: "artifact",
      pathname: "/index.html",
    });
    expect(
      isAllowedRequestUrl(`${INLINE_HOST_ORIGIN}/__coforge_check_inline_host__`, {
        artifactOrigin: origin,
        hostOrigin: INLINE_HOST_ORIGIN,
        allowedCdnHosts: cdns,
      }),
    ).toEqual({
      allowed: true,
      kind: "host",
      pathname: "/__coforge_check_inline_host__",
    });
    expect(
      isAllowedRequestUrl("https://cdn.jsdelivr.net/npm/chart.js", {
        artifactOrigin: origin,
        hostOrigin: INLINE_HOST_ORIGIN,
        allowedCdnHosts: cdns,
      }),
    ).toEqual({ allowed: true, kind: "cdn", hostname: "cdn.jsdelivr.net" });
    expect(
      isAllowedRequestUrl("data:image/png;base64,AA==", {
        artifactOrigin: origin,
        allowedCdnHosts: cdns,
      }),
    ).toEqual({
      allowed: true,
      kind: "internal",
    });
  });

  test("blocks private IPs, metadata, single-label Docker hosts, .internal, non-443 ports, and unknown hosts", () => {
    const blocked = [
      "http://169.254.169.254/latest/meta-data/",
      "https://100.100.100.200/latest/meta-data/",
      "http://127.0.0.1:3000/api/health",
      "https://web/api/health",
      "https://postgres/secret",
      "https://checker.internal/check",
      "https://localhost/secret",
      "https://[::1]/secret",
      "http://cdn.jsdelivr.net/npm/chart.js",
      "https://cdn.jsdelivr.net:8443/npm/chart.js",
      "https://evil.example/steal.js",
      "https://a-other.coforge.check/index.html",
    ];
    for (const url of blocked) {
      expect(
        isAllowedRequestUrl(url, {
          artifactOrigin: origin,
          hostOrigin: INLINE_HOST_ORIGIN,
          allowedCdnHosts: [...cdns, "web", "checker.internal"],
        }).allowed,
      ).toBe(false);
    }
  });

  test("normalizes bundle paths and rejects directory traversal", () => {
    expect(normalizeBundlePath("/index.html")).toBe("index.html");
    expect(normalizeBundlePath("/assets/chart%20v1.js")).toBe("assets/chart v1.js");
    expect(normalizeBundlePath("/")).toBe("");
    expect(normalizeBundlePath("/../etc/passwd")).toBeNull();
    expect(normalizeBundlePath("/a/./b")).toBeNull();
  });
});

describe("artifact-checker inline host and helpers", () => {
  test("clamps inline frame height between 96 and 800", () => {
    expect(clampInlineHeight(0)).toBe(200);
    expect(clampInlineHeight(40)).toBe(96);
    expect(clampInlineHeight(345.2)).toBe(346);
    expect(clampInlineHeight(1500)).toBe(800);
  });

  test("builds sandboxed inline host HTML and escapes script breakouts", () => {
    const html = buildInlineHostHtml({
      entryUrl: "https://a-1.coforge.check/</script><script>alert(1)</script>",
      artifactOrigin: "https://a-1.coforge.check",
    });
    expect(html).toContain('sandbox="allow-scripts allow-same-origin"');
    expect(html).toContain("ui/initialize");
    expect(html).toContain(INLINE_LIGHT_TOKENS["--coforge-fg"]);
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>");
  });
});

describe("artifact-checker HTTP server", () => {
  test("fails closed when secret is empty unless allowUnauthenticated is explicitly enabled", () => {
    expect(isAuthorizedBearer("Bearer abc123", "abc123")).toBe(true);
    expect(isAuthorizedBearer("Bearer wrong", "abc123")).toBe(false);
    expect(isAuthorizedBearer(undefined, "abc123")).toBe(false);
    expect(isAuthorizedBearer(undefined, "")).toBe(false);
    expect(isAuthorizedBearer(undefined, "", { allowUnauthenticated: true })).toBe(true);
  });

  test("serves /health, enforces Bearer auth and origin validation, runs checks, and emits structured logs", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const logger = {
      info: (p: Record<string, unknown>) => logs.push(p),
      warn: (p: Record<string, unknown>) => logs.push(p),
      error: (p: Record<string, unknown>) => logs.push(p),
    };
    const checker = createCheckerServer({
      secret: "worker-secret",
      maxConcurrency: 1,
      logger,
      driver: {
        isBrowserActive: () => false,
        close: async () => {},
        runCheck: async (payload: { artifactId: string }) => ({
          findings: {
            consoleErrors: [],
            blockedResources: [],
            blank: false,
            phoneOverflow: null,
            inlineOverflow: { contentHeight: 320, maxHeight: 800, clipped: false },
          },
          screenshots: [
            {
              shot: "desktop",
              contentType: "image/png",
              base64: Buffer.from(`png:${payload.artifactId}`).toString("base64"),
            },
          ],
          metrics: { shotDurationsMs: { desktop: 120 }, workerRssMb: 88, browserLaunched: false },
        }),
      },
    });

    const server = checker.start({ hostname: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${server.port}`;

    try {
      const healthRes = await fetch(`${base}/health`);
      expect(healthRes.status).toBe(200);
      const health = (await healthRes.json()) as Record<string, unknown>;
      expect(health.ok).toBe(true);
      expect(health.maxConcurrency).toBe(1);

      const unauthRes = await fetch(`${base}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin: "https://a-1.coforge.check", files: [] }),
      });
      expect(unauthRes.status).toBe(401);

      const badOriginRes = await fetch(`${base}/check`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer worker-secret",
        },
        body: JSON.stringify({ origin: "https://evil.example", files: [] }),
      });
      expect(badOriginRes.status).toBe(400);

      const okRes = await fetch(`${base}/check`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer worker-secret",
        },
        body: JSON.stringify({
          checkId: "chk-1",
          artifactId: "art-1",
          version: 1,
          origin: "https://a-art-1.coforge.check",
          files: [],
        }),
      });
      expect(okRes.status).toBe(200);
      const body = (await okRes.json()) as {
        findings: { blank: boolean };
        screenshots: Array<{ shot: string }>;
      };
      expect(body.findings.blank).toBe(false);
      expect(body.screenshots[0]?.shot).toBe("desktop");
      expect(logs.map((entry) => entry.event)).toEqual([
        "artifact_checker.auth_rejected",
        "artifact_checker.job_started",
        "artifact_checker.job_completed",
      ]);
      const completedLog = logs.find((entry) => entry.event === "artifact_checker.job_completed");
      expect(completedLog?.brokenImageCount).toBe(0);
      expect(completedLog?.failedAssetCount).toBe(0);
      expect(completedLog?.scrollLockCount).toBe(0);
      expect(completedLog?.phoneOverflow).toBe(false);
      expect(completedLog?.inlineClipped).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});

test("the checker accepts authorized requests through its private Unix socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "checker-sock-"));
  const socket = join(directory, "checker.sock");
  const checker = createCheckerServer({
    secret: crypto.randomUUID(),
    logger: { info() {}, warn() {}, error() {} },
  });
  const server = checker.start({ socket });
  try {
    const response = await fetch("http://artifact-checker/health", { unix: socket });
    expect(response.status).toBe(200);
    const denied = await fetch("http://artifact-checker/check", { unix: socket, method: "POST", body: "{}" });
    expect(denied.status).toBe(401);
  } finally {
    server.stop(true);
    await checker.driver.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("allowed CDN requests without the configured proxy are blocked", async () => {
  const url = "https://fixture.invalid/style.css";
  expect(await fetchCdnSafely(url, { allowedCdnHosts: ["fixture.invalid"] })).toEqual({
    ok: false,
    blockedUrl: url,
  });
});

test("Bun sends an allowed CDN request through the configured CONNECT proxy", async () => {
  const received: string[] = [];
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, chunk) {
        received.push(chunk.toString().split("\r\n")[0]!);
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      },
    },
  });
  try {
    await fetchCdnSafely("https://fixture.invalid/style.css", {
      allowedCdnHosts: ["fixture.invalid"],
      proxy: `http://127.0.0.1:${listener.port}`,
    }).catch(() => undefined);
    expect(received).toEqual(["CONNECT fixture.invalid:443 HTTP/1.1"]);
  } finally {
    listener.stop(true);
  }
});
