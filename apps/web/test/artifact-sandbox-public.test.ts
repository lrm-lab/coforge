import { describe, expect, test } from "bun:test";
import { ArtifactSandbox } from "#src/server/artifacts/artifact-sandbox.server";
import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";

/** Public links on the sandbox origin (task #646): what the sandbox answers for `/p/<token>`. */

const SECRET = "s".repeat(40);
const SANDBOX = "https://sandbox.example";
const NOW = new Date("2026-11-04T08:00:00Z");
const PAGE = new TextEncoder().encode("<!doctype html><p>hi</p>");

describe("the sandbox's answer", () => {
  test("a public Markdown link serves escaped content and is revocable", async () => {
    const token = "p".repeat(43);
    let live = true;
    const service = new ArtifactSandbox({
      reads: {} as never,
      readBlob: async () => new TextEncoder().encode("# hi <script>alert(1)</script>"),
      origin: SANDBOX,
      secret: async () => SECRET,
      now: () => NOW,
      publicPage: async (value) =>
        live && value === token
          ? {
              workspaceId: "w1",
              artifactId: "a1",
              title: "Read me",
              kind: "markdown",
              sha256: "sha",
            }
          : null,
      publicClientAddress: () => "192.0.2.1",
    });
    const response = await service.serve(new Request(`${SANDBOX}/p/${token}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("/p/" + token + "/page");
    const page = await service.serve(
      new Request(`${SANDBOX}/p/${token}/page`, {
        headers: { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "same-origin" },
      }),
    );
    const html = await page.text();
    expect(html).toContain("<h1>hi");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(page.headers.get("content-security-policy")).toContain(`frame-ancestors ${SANDBOX}`);
    live = false;
    expect((await service.serve(new Request(`${SANDBOX}/p/${token}`))).status).toBe(404);
  });

  test("public links require the wrapper iframe and support HEAD", async () => {
    const token = "q".repeat(43);
    const service = new ArtifactSandbox({
      reads: {} as never,
      readBlob: async () => PAGE,
      origin: SANDBOX,
      secret: async () => SECRET,
      now: () => NOW,
      publicPage: async () => ({
        workspaceId: "w1",
        artifactId: "a1",
        title: "Page",
        kind: "html" as const,
        sha256: "sha",
      }),
    });
    expect((await service.serve(new Request(`${SANDBOX}/p/${token}/page`))).status).toBe(404);
    const head = await service.serve(
      new Request(`${SANDBOX}/p/${token}/page`, {
        method: "HEAD",
        headers: { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "same-origin" },
      }),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("public reads return 429 when the IP limit is exhausted", async () => {
    const token = "r".repeat(43);
    const limiter: AppRateLimit = {
      admit: async () => ({ allowed: false, retryAfterSeconds: 17 }),
    };
    const service = new ArtifactSandbox({
      reads: {} as never,
      readBlob: async () => PAGE,
      origin: SANDBOX,
      secret: async () => SECRET,
      now: () => NOW,
      publicRateLimit: limiter,
      publicPage: async () => ({
        workspaceId: "w1",
        artifactId: "a1",
        title: "Page",
        kind: "html" as const,
        sha256: "sha",
      }),
    });
    const response = await service.serve(new Request(`${SANDBOX}/p/${token}`));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
  });
});
