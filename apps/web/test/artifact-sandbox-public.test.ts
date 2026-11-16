import { describe, expect, test } from "bun:test";
import { ArtifactSandbox } from "#src/server/artifacts/artifact-sandbox.server";
import { MemoryTicketNonces } from "#src/server/artifacts/artifact-sandbox-nonces.server";
import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";
import { FRAME, subresource } from "./helpers/artifact-sandbox-open";

/**
 * A page's public link (`/p/<token>`) on its artifact's origin: no reader, a rate limit per client
 * address, the token's own revocation, and a page of its own, not framed by anyone.
 */

const SECRET = "s".repeat(40);
const SANDBOX = "https://sandbox.example";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ORIGIN = `https://a-${A}.sandbox.example`;
const NOW = new Date("2026-11-04T08:00:00Z");
const PAGE = new TextEncoder().encode("<!doctype html><p>hi</p>");

type Lookup = {
  workspaceId: string;
  artifactId: string;
  title: string;
  kind: "html" | "markdown";
  entryPath: string;
  sha256: string;
};

function publicSandbox(
  publicPage: (token: string, path?: string) => Promise<Lookup | null>,
  options: {
    readBlob?: (workspaceId: string, sha256: string) => Promise<Uint8Array | null>;
    publicRateLimit?: AppRateLimit;
    publicFileRateLimit?: AppRateLimit;
  } = {},
) {
  return new ArtifactSandbox({
    reads: {} as never,
    readBlob: options.readBlob ?? (async () => PAGE),
    origin: SANDBOX,
    nonces: new MemoryTicketNonces(),
    secret: async () => SECRET,
    now: () => NOW,
    publicPage,
    publicRateLimit: options.publicRateLimit,
    publicFileRateLimit: options.publicFileRateLimit,
    publicClientAddress: () => "192.0.2.1",
  });
}

const page = (overrides: Partial<Lookup> = {}): Lookup => ({
  workspaceId: "w1",
  artifactId: A,
  title: "Page",
  kind: "html",
  entryPath: "index.html",
  sha256: "sha",
  ...overrides,
});

describe("a public link", () => {
  test("a public Markdown link serves escaped content, unframed, and is revocable", async () => {
    const token = "p".repeat(43);
    let live = true;
    const service = publicSandbox(
      async (value) =>
        live && value === token
          ? page({ title: "Read me", kind: "markdown", entryPath: "document.md" })
          : null,
      {
        readBlob: async () => new TextEncoder().encode("# hi <script>alert(1)</script>"),
      },
    );
    const redirect = await service.serve(new Request(`${ORIGIN}/p/${token}`));
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(`/p/${token}/page/document.md`);
    const shown = await service.serve(
      new Request(`${ORIGIN}/p/${token}/page/document.md`, { headers: FRAME }),
    );
    const html = await shown.text();
    expect(html).toContain("<h1>hi");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(shown.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(shown.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    live = false;
    expect((await service.serve(new Request(`${ORIGIN}/p/${token}`))).status).toBe(404);
  });

  test("lives only on its artifact's origin", async () => {
    const token = "q".repeat(43);
    const service = publicSandbox(async () => page());
    expect((await service.serve(new Request(`${ORIGIN}/p/${token}`))).status).toBe(302);
    for (const origin of [SANDBOX, `https://a-${B}.sandbox.example`, "https://www.sandbox.example"])
      expect((await service.serve(new Request(`${origin}/p/${token}`))).status, origin).toBe(404);
  });

  test("a public web page is a document for a frame or a tab, framed by no one, and supports HEAD", async () => {
    const token = "q".repeat(43);
    const service = publicSandbox(async () => page());
    expect((await service.serve(new Request(`${ORIGIN}/p/${token}/page/index.html`))).status).toBe(
      404,
    );
    const head = await service.serve(
      new Request(`${ORIGIN}/p/${token}/page/index.html`, { method: "HEAD", headers: FRAME }),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const document = await service.serve(
      new Request(`${ORIGIN}/p/${token}/page/index.html`, { headers: FRAME }),
    );
    const csp = document.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("sandbox allow-scripts allow-same-origin");
    expect(await document.text()).toStartWith(
      '<!doctype html><script src="/_coforge/runtime.js"></script>',
    );
  });

  test("public reads return 429 when the IP limit is exhausted", async () => {
    const token = "r".repeat(43);
    const service = publicSandbox(async () => page(), {
      publicRateLimit: { admit: async () => ({ allowed: false, retryAfterSeconds: 17 }) },
    });
    const response = await service.serve(new Request(`${ORIGIN}/p/${token}`));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
  });

  const files: Record<string, string> = {
    "index.html": "<!doctype html><link rel=stylesheet href=site.css>",
    "other.html": "<!doctype html><p>other</p>",
    "site.css": "p{color:red}",
    "document.md": "# hi",
  };
  function multi(kind: "html" | "markdown", entryPath: string, limits = {}) {
    const lookups: (string | undefined)[] = [];
    const service = publicSandbox(
      async (_token, path) => {
        lookups.push(path);
        const at = path ?? entryPath;
        return at in files ? page({ title: "T", kind, entryPath, sha256: at }) : null;
      },
      {
        readBlob: async (_workspaceId, sha256) => new TextEncoder().encode(files[sha256] ?? ""),
        ...limits,
      },
    );
    return { service, lookups };
  }
  const token = "m".repeat(43);
  const asking = (path: string, headers: Record<string, string>) =>
    new Request(`${ORIGIN}/p/${token}/page/${path}`, { headers });

  test("a public web page serves every file of its version under its own prefix", async () => {
    const { service } = multi("html", "index.html");
    const entry = await service.serve(new Request(`${ORIGIN}/p/${token}`));
    expect(entry.headers.get("location")).toBe(`/p/${token}/page/index.html`);
    const shown = await service.serve(asking("index.html", FRAME));
    expect(shown.status).toBe(200);
    expect(shown.headers.get("content-security-policy")).toContain(
      `script-src 'unsafe-inline' 'unsafe-eval' blob: ${ORIGIN}/_coforge/runtime.js ${ORIGIN}/p/${token}/page/`,
    );
    expect((await service.serve(asking("other.html", FRAME))).status).toBe(200);
    const css = await service.serve(asking("site.css", subresource("style")));
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(await css.text()).toBe("p{color:red}");
    expect((await service.serve(asking("missing.css", subresource("style")))).status).toBe(404);
  });

  test("a public file keeps the fetch-metadata rules, and a bad path looks nothing up", async () => {
    const { service, lookups } = multi("html", "index.html");
    expect((await service.serve(asking("site.css", { "Sec-Fetch-Dest": "document" }))).status).toBe(
      404,
    );
    expect((await service.serve(asking("other.html", {}))).status).toBe(404);
    expect((await service.serve(asking("other.html", { "Sec-Fetch-Dest": "embed" }))).status).toBe(
      404,
    );
    expect((await service.serve(asking("..%2fx.css", subresource("style")))).status).toBe(404);
    expect((await service.serve(new Request(`${ORIGIN}/p/${token}/page`))).status).toBe(404);
    expect(lookups).toEqual([]);
  });

  test("a public page's files are cached briefly, the page not at all", async () => {
    const { service } = multi("html", "index.html");
    const css = await service.serve(asking("site.css", subresource("style")));
    expect(css.headers.get("cache-control")).toBe("private, max-age=60");
    const shown = await service.serve(asking("index.html", FRAME));
    expect(shown.headers.get("cache-control")).toBe("no-store");
  });

  test("a page load spends the page limit; a page's files a far higher one of their own", async () => {
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
      multi("html", "index.html", { publicRateLimit: pageLimit, publicFileRateLimit: fileLimit })
        .service;
    const generous = build(counting("pages", 2), counting("files"));
    expect((await generous.serve(new Request(`${ORIGIN}/p/${token}`))).status).toBe(302);
    expect((await generous.serve(asking("index.html", FRAME))).status).toBe(200);
    for (let i = 0; i < 150; i++)
      expect((await generous.serve(asking("site.css", subresource("style")))).status).toBe(200);
    expect(spent).toEqual({ pages: 2, files: 150 });
    const tight = build(counting("pages"), counting("files", 1));
    expect((await tight.serve(asking("site.css", subresource("style")))).status).toBe(200);
    const refused = await tight.serve(asking("site.css", subresource("style")));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("9");
    const pagesOnly = build(counting("pages", 1), counting("files", 0));
    expect((await pagesOnly.serve(asking("index.html", FRAME))).status).toBe(200);
    expect((await pagesOnly.serve(asking("index.html", FRAME))).status).toBe(429);
  });

  test("a public Markdown page serves its entry file only", async () => {
    const { service } = multi("markdown", "document.md");
    expect((await service.serve(asking("document.md", FRAME))).status).toBe(200);
    for (const path of ["site.css", "other.html"])
      expect((await service.serve(asking(path, FRAME))).status).toBe(404);
  });
});
