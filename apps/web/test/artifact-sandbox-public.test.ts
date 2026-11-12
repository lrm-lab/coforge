import { describe, expect, test } from "bun:test";
import { ArtifactSandbox } from "#src/server/artifacts/artifact-sandbox.server";
import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";

/**
 * A page's public link (`/p/<token>`) on the sandbox origin: the same wrapper and frame as a
 * signed link, with no reader, a rate limit per client address, and the token's own revocation.
 */

const SECRET = "s".repeat(40);
const SANDBOX = "https://sandbox.example";
const NOW = new Date("2026-11-04T08:00:00Z");
const PAGE = new TextEncoder().encode("<!doctype html><p>hi</p>");

describe("a public link", () => {
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
              entryPath: "document.md",
              sha256: "sha",
            }
          : null,
      publicClientAddress: () => "192.0.2.1",
    });
    const response = await service.serve(new Request(`${SANDBOX}/p/${token}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("/p/" + token + "/page/document.md");
    const page = await service.serve(
      new Request(`${SANDBOX}/p/${token}/page/document.md`, {
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
        entryPath: "index.html",
        sha256: "sha",
      }),
    });
    expect((await service.serve(new Request(`${SANDBOX}/p/${token}/page/index.html`))).status).toBe(
      404,
    );
    const head = await service.serve(
      new Request(`${SANDBOX}/p/${token}/page/index.html`, {
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
        entryPath: "index.html",
        sha256: "sha",
      }),
    });
    const response = await service.serve(new Request(`${SANDBOX}/p/${token}`));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
  });

  const files: Record<string, string> = {
    "index.html": "<!doctype html><link rel=stylesheet href=site.css>",
    "other.html": "<!doctype html><p>other</p>",
    "site.css": "p{color:red}",
    "document.md": "# hi",
  };
  /** A public link over a version of several files; the lookups it made. */
  function multi(kind: "html" | "markdown", entryPath: string) {
    const lookups: (string | undefined)[] = [];
    const service = new ArtifactSandbox({
      reads: {} as never,
      readBlob: async (_workspaceId, sha256) => new TextEncoder().encode(files[sha256] ?? ""),
      origin: SANDBOX,
      secret: async () => SECRET,
      now: () => NOW,
      publicPage: async (_token, path) => {
        lookups.push(path);
        const at = path ?? entryPath;
        return at in files
          ? { workspaceId: "w1", artifactId: "a1", title: "T", kind, entryPath, sha256: at }
          : null;
      },
      publicClientAddress: () => "192.0.2.1",
    });
    return { service, lookups };
  }
  const token = "m".repeat(43);
  const asking = (path: string, dest: string, site: string) =>
    new Request(`${SANDBOX}/p/${token}/page/${path}`, {
      headers: { "Sec-Fetch-Dest": dest, "Sec-Fetch-Site": site },
    });

  test("a public web page serves every file of its version under its own prefix", async () => {
    const { service } = multi("html", "index.html");
    const wrapper = await service.serve(new Request(`${SANDBOX}/p/${token}`));
    expect(await wrapper.text()).toContain(`src="/p/${token}/page/index.html"`);
    const page = await service.serve(asking("index.html", "iframe", "same-origin"));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      `script-src 'unsafe-inline' ${SANDBOX}/p/${token}/page/`,
    );
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect((await service.serve(asking("other.html", "iframe", "cross-site"))).status).toBe(200);
    const css = await service.serve(asking("site.css", "style", "cross-site"));
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(css.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await css.text()).toBe("p{color:red}");
    expect((await service.serve(asking("missing.css", "style", "cross-site"))).status).toBe(404);
  });

  test("a public file keeps the fetch-metadata rules, and a bad path looks nothing up", async () => {
    const { service, lookups } = multi("html", "index.html");
    expect((await service.serve(asking("site.css", "document", "none"))).status).toBe(404);
    expect((await service.serve(asking("other.html", "document", "none"))).status).toBe(404);
    expect((await service.serve(asking("other.html", "iframe", "same-site"))).status).toBe(404);
    expect((await service.serve(asking("other.html", "image", "cross-site"))).status).toBe(404);
    expect((await service.serve(asking("..%2fx.css", "style", "cross-site"))).status).toBe(404);
    expect((await service.serve(new Request(`${SANDBOX}/p/${token}/page`))).status).toBe(404);
    expect(lookups).toEqual([]);
    // A non-page file asked for as a frame is refused once looked up (its artifact might be Markdown).
    expect((await service.serve(asking("site.css", "iframe", "same-origin"))).status).toBe(404);
  });

  test("a public page's files are cached briefly, the page and wrapper not at all", async () => {
    const { service } = multi("html", "index.html");
    const css = await service.serve(asking("site.css", "style", "cross-site"));
    expect(css.headers.get("cache-control")).toBe("private, max-age=60");
    const page = await service.serve(asking("index.html", "iframe", "same-origin"));
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(
      (await service.serve(new Request(`${SANDBOX}/p/${token}`))).headers.get("cache-control"),
    ).toBe("no-store");
  });

  test("the wrapper and its frames spend the page limit; a page's files a far higher one of their own", async () => {
    const spent = { pages: 0, files: 0 };
    const counting = (name: "pages" | "files", cap = Infinity): AppRateLimit => {
      let count = 0;
      return {
        admit: async () => {
          spent[name] += 1;
          return ++count > cap ? { allowed: false, retryAfterSeconds: 9 } : { allowed: true };
        },
      };
    };
    const build = (pageLimit: AppRateLimit, fileLimit: AppRateLimit) =>
      new ArtifactSandbox({
        reads: {} as never,
        readBlob: async (_workspaceId, sha256) => new TextEncoder().encode(files[sha256] ?? ""),
        origin: SANDBOX,
        secret: async () => SECRET,
        now: () => NOW,
        publicPage: async (_token, path) => {
          const at = path ?? "index.html";
          return at in files
            ? {
                workspaceId: "w1",
                artifactId: "a1",
                title: "T",
                kind: "html",
                entryPath: "index.html",
                sha256: at,
              }
            : null;
        },
        publicRateLimit: pageLimit,
        publicFileRateLimit: fileLimit,
        publicClientAddress: () => "192.0.2.1",
      });
    // A page of 150 files loads, though the page limit would stop it at 120 requests.
    const generous = build(counting("pages", 2), counting("files"));
    expect((await generous.serve(new Request(`${SANDBOX}/p/${token}`))).status).toBe(200);
    expect((await generous.serve(asking("index.html", "iframe", "same-origin"))).status).toBe(200);
    for (let i = 0; i < 150; i++)
      expect((await generous.serve(asking("site.css", "style", "cross-site"))).status).toBe(200);
    expect(spent).toEqual({ pages: 2, files: 150 });
    // The files' own limit still holds, and answers 429 with its Retry-After.
    const tight = build(counting("pages"), counting("files", 1));
    expect((await tight.serve(asking("site.css", "style", "cross-site"))).status).toBe(200);
    const refused = await tight.serve(asking("site.css", "style", "cross-site"));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("9");
    // A page file asked for as a frame is a page load; the files limit does not pay for it.
    const pagesOnly = build(counting("pages", 1), counting("files", 0));
    expect((await pagesOnly.serve(asking("index.html", "iframe", "same-origin"))).status).toBe(200);
    expect((await pagesOnly.serve(asking("index.html", "iframe", "same-origin"))).status).toBe(429);
  });

  test("a public Markdown page serves its entry file only", async () => {
    const { service } = multi("markdown", "document.md");
    expect((await service.serve(asking("document.md", "iframe", "same-origin"))).status).toBe(200);
    for (const path of ["site.css", "other.html"])
      expect((await service.serve(asking(path, "iframe", "same-origin"))).status).toBe(404);
  });
});
