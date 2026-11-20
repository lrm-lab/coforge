import { describe, expect, test } from "bun:test";
import {
  artifactCheckConfig,
  artifactChecksEnabled,
} from "#src/server/artifacts/artifact-check-config.server";
import type { ArtifactCheckLogger } from "#src/server/artifacts/artifact-check-log.server";
import {
  ArtifactCheckRunnerError,
  createHttpArtifactCheckRunner,
  type ArtifactCheckRunInput,
} from "#src/server/artifacts/artifact-check-runner.server";

function makeLogger() {
  const events: Array<{ level: "info" | "warn" | "error"; payload: Record<string, unknown> }> = [];
  const logger: ArtifactCheckLogger = {
    info: (payload) => events.push({ level: "info", payload }),
    warn: (payload) => events.push({ level: "warn", payload }),
    error: (payload) => events.push({ level: "error", payload }),
  };
  return { events, logger };
}

describe("artifactCheckConfig", () => {
  test("requires bearer authentication for the production socket", () => {
    const socket = "/run/artifact-checker/checker.sock";
    expect(artifactCheckConfig({ COFORGE_ARTIFACT_CHECK_WORKER_SOCKET: socket })).toBeNull();
    expect(
      artifactCheckConfig({
        COFORGE_ARTIFACT_CHECK_WORKER_SOCKET: socket,
        COFORGE_ARTIFACT_CHECK_SECRET: crypto.randomUUID(),
      }),
    ).toMatchObject({ workerSocket: socket, workerUrl: "http://artifact-checker" });
  });

  test("returns null when URL is missing, malformed, non-http, or non-loopback without secret", () => {
    expect(artifactCheckConfig({})).toBeNull();
    expect(artifactCheckConfig({ COFORGE_ARTIFACT_CHECK_WORKER_URL: "not-a-url" })).toBeNull();
    expect(
      artifactCheckConfig({ COFORGE_ARTIFACT_CHECK_WORKER_URL: "ftp://checker:3100" }),
    ).toBeNull();
    expect(
      artifactCheckConfig({ COFORGE_ARTIFACT_CHECK_WORKER_URL: "http://artifact-checker:3100" }),
    ).toBeNull();
    expect(artifactChecksEnabled({})).toBe(false);
    expect(
      artifactChecksEnabled({ COFORGE_ARTIFACT_CHECK_WORKER_URL: "http://127.0.0.1:3100" }),
    ).toBe(true);
  });

  test("normalizes trailing slashes and clamps concurrency, timeout, and daily cap bounds", () => {
    const cfg = artifactCheckConfig({
      COFORGE_ARTIFACT_CHECK_WORKER_URL: "http://artifact-checker:3100///",
      COFORGE_ARTIFACT_CHECK_SECRET: "  top-secret  ",
      COFORGE_ARTIFACT_CHECK_CONCURRENCY: "99",
      COFORGE_ARTIFACT_CHECK_TIMEOUT_MS: "1000",
      COFORGE_ARTIFACT_CHECK_DAILY_CAP: "50000",
    });
    expect(cfg).toEqual({
      workerUrl: "http://artifact-checker:3100",
      secret: "top-secret",
      concurrency: 4,
      timeoutMs: 5_000,
      dailyCap: 10_000,
    });
    expect(
      artifactCheckConfig({
        COFORGE_ARTIFACT_CHECK_WORKER_URL: "http://127.0.0.1:3100",
      })?.dailyCap,
    ).toBe(200);
    expect(
      artifactCheckConfig({
        COFORGE_ARTIFACT_CHECK_WORKER_URL: "http://127.0.0.1:3100",
        COFORGE_ARTIFACT_CHECK_DAILY_CAP: "0",
      })?.dailyCap,
    ).toBe(0);
    expect(
      artifactCheckConfig({
        COFORGE_ARTIFACT_CHECK_WORKER_URL: "http://127.0.0.1:3100",
        COFORGE_ARTIFACT_CHECK_DAILY_CAP: "-5",
      })?.dailyCap,
    ).toBe(200);
    expect(
      artifactChecksEnabled({
        COFORGE_ARTIFACT_CHECK_WORKER_URL: "http://artifact-checker:3100",
        COFORGE_ARTIFACT_CHECK_SECRET: "secret",
      }),
    ).toBe(true);
  });
});

describe("createHttpArtifactCheckRunner", () => {
  test("sends Bearer secret and decodes shots from sidecar response", async () => {
    let seenAuth = "";
    let seenUrl = "";
    const runner = createHttpArtifactCheckRunner(
      {
        workerUrl: "http://checker.internal:3100",
        secret: "s3cr3t",
        concurrency: 1,
        timeoutMs: 30_000,
        dailyCap: 200,
      },
      {
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          seenUrl = String(url);
          const headers = init?.headers as Record<string, string>;
          seenAuth = headers.Authorization ?? "";
          return new Response(
            JSON.stringify({
              findings: {
                consoleErrors: [],
                blockedResources: [],
                blank: false,
                phoneOverflow: null,
                inlineOverflow: null,
              },
              screenshots: [
                {
                  shot: "desktop",
                  contentType: "image/png",
                  base64: Buffer.from([1, 2, 3]).toString("base64"),
                },
                {
                  shot: "invalid",
                  contentType: "image/png",
                  base64: Buffer.from([1, 2, 3]).toString("base64"),
                },
              ],
              metrics: { workerRssMb: 120 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }) as unknown as typeof fetch,
      },
    );

    const out = await runner.run({
      checkId: "chk-1",
      workspaceId: "ws-1",
      artifactId: "art-1",
      version: 1,
      entryPath: "index.html",
      origin: "https://a-art-1.coforge.check",
      csp: "default-src 'none'",
      runtimeJs: "",
      allowedCdnHosts: [],
      files: [],
      viewports: [],
      timeoutMs: 30_000,
    });
    expect(seenUrl).toBe("http://checker.internal:3100/check");
    expect(seenAuth).toBe("Bearer s3cr3t");
    expect(out.screenshots).toHaveLength(1);
    expect(out.screenshots[0]!.shot).toBe("desktop");
    expect(out.metrics?.workerRssMb).toBe(120);
  });

  test("classifies HTTP 502 and 504 errors and logs worker_http_error", async () => {
    const { events, logger } = makeLogger();
    const mkRunner = (status: number) =>
      createHttpArtifactCheckRunner(
        {
          workerUrl: "http://checker.internal:3100",
          secret: "",
          concurrency: 1,
          timeoutMs: 10_000,
          dailyCap: 200,
        },
        {
          logger,
          fetchImpl: (async () =>
            new Response("upstream failure", { status })) as unknown as typeof fetch,
        },
      );

    const baseInput: ArtifactCheckRunInput = {
      checkId: "chk-1",
      workspaceId: "ws-1",
      artifactId: "art-1",
      version: 1,
      entryPath: "index.html",
      origin: "https://a-art-1.coforge.check",
      csp: "",
      runtimeJs: "",
      allowedCdnHosts: [],
      files: [],
      viewports: [],
      timeoutMs: 10_000,
    };

    const err502 = await mkRunner(502)
      .run(baseInput)
      .catch((err) => err);
    expect(err502).toBeInstanceOf(ArtifactCheckRunnerError);
    expect((err502 as ArtifactCheckRunnerError).errorClass).toBe("worker_http_5xx");

    const err504 = await mkRunner(504)
      .run(baseInput)
      .catch((err) => err);
    expect(err504).toBeInstanceOf(ArtifactCheckRunnerError);
    expect((err504 as ArtifactCheckRunnerError).errorClass).toBe("worker_timeout");
    expect(
      events.filter((e) => e.payload.event === "artifact_check.worker_http_error"),
    ).toHaveLength(2);
  });
});
