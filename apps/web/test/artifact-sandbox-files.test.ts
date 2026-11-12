import { describe, expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import {
  decodeSandboxFilePath,
  sandboxFileUrlPath,
} from "#src/server/artifacts/artifact-sandbox-path.server";
import { ArtifactSandbox } from "#src/server/artifacts/artifact-sandbox.server";
import {
  SANDBOX_FILE_TTL_SECONDS,
  SANDBOX_TICKET_TTL_SECONDS,
} from "#src/server/artifacts/artifact-sandbox-ticket.server";

/**
 * A web page of several files on the sandbox origin: every file of the linked version is served
 * under the link's own prefix (`/a/<ticket>/page/<path>`), an `.html` file only as a frame, any
 * other file only as a subresource, and the ticket's reach in time and in files. The browser's
 * side is `artifact-sandbox-browser.e2e.ts`; real reads are `artifact-sandbox.integration.ts`.
 */

const SECRET = "s".repeat(40);
const SANDBOX = "https://sandbox.example";
const APP = "https://app.example";
const NOW = new Date("2026-11-04T08:00:00Z");
const text = (value: string) => new TextEncoder().encode(value);

describe("a file path in the sandbox's URL", () => {
  test("is decoded one percent-encoded segment at a time", () => {
    expect(decodeSandboxFilePath("index.html")).toBe("index.html");
    expect(decodeSandboxFilePath("css/site.css")).toBe("css/site.css");
    expect(decodeSandboxFilePath("img/%E6%97%A5%E6%9C%AC%20a.png")).toBe("img/日本 a.png");
    expect(decodeSandboxFilePath("a%25b.txt")).toBe("a%b.txt");
  });

  test("is refused, before any lookup, when it could leave its prefix or name no file", () => {
    for (const raw of [
      "",
      "/",
      "/abs.html",
      "a//b.css",
      "dir/",
      ".",
      "..",
      "../a.css",
      "a/../b.css",
      "a/./b.css",
      "%2e%2e/a.css",
      "%2E/a.css",
      "a%2Fb.css",
      "..%2fa.css",
      "a%5Cb.css",
      "a\\b.css",
      "a%00b.css",
      "%ZZ.css",
      "%E0%A4%A.css",
      "c:x.css",
    ])
      expect(decodeSandboxFilePath(raw), raw).toBeNull();
  });

  test("is written back with every segment percent-encoded", () => {
    expect(sandboxFileUrlPath("index.html")).toBe("index.html");
    expect(sandboxFileUrlPath("img/日本 a?b#c.png")).toBe("img/%E6%97%A5%E6%9C%AC%20a%3Fb%23c.png");
    for (const path of ["a b/c%d.png", "日本/x y.html", "q?x/y#z.css"])
      expect(decodeSandboxFilePath(sandboxFileUrlPath(path))).toBe(path);
  });
});

type Version = { entryPath: string; files: Record<string, string> };

/** A sandbox over a fake read of one multi-file page, at a fixed time. */
function sandbox(version: Version = site(), options: { readable?: () => boolean } = {}) {
  const lookups: string[] = [];
  const check = () => {
    if (options.readable && !options.readable()) throw new AppError("NOT_FOUND");
  };
  const row = (path: string) => ({
    path,
    sha256: `sha:${path}`,
    sizeBytes: text(version.files[path]!).byteLength,
    kind: "text",
  });
  const reads = {
    read: async () => {
      check();
      return {
        artifact: { currentVersion: 3 },
        version: { number: 3, entryPath: version.entryPath },
        files: Object.keys(version.files).map(row),
      };
    },
    file: async (input: { path: string; version?: number }) => {
      check();
      lookups.push(input.path);
      return input.path in version.files ? row(input.path) : null;
    },
  };
  let now = NOW;
  const service = new ArtifactSandbox({
    reads: reads as never,
    readBlob: async (_workspaceId, sha256) => {
      const path = sha256.slice("sha:".length);
      return path in version.files ? text(version.files[path]!) : null;
    },
    origin: SANDBOX,
    secret: async () => SECRET,
    now: () => now,
  });
  return {
    service,
    lookups,
    at: (ms: number) => (now = new Date(NOW.getTime() + ms)),
  };
}

function site(): Version {
  return {
    entryPath: "home page.html",
    files: {
      "home page.html":
        '<!doctype html><link rel="stylesheet" href="css/site.css"><script src="app.js"></script>',
      "other.html": "<!doctype html><p>other</p>",
      "css/site.css": "p{color:red}",
      "app.js": "document.title='x'",
      "img/a.png": "not really a png",
      "fonts/x.woff2": "font bytes",
      "data.unknownext": "bytes",
    },
  };
}

const linkInput = { workspaceId: "w1", userId: "u1", artifactId: "a1", embedderOrigin: APP };
const ticketOf = (url: string) => url.slice(`${SANDBOX}/a/`.length);

async function opened(version?: Version, options?: Parameters<typeof sandbox>[1]) {
  const box = sandbox(version, options);
  const { url } = await box.service.link(linkInput);
  return { ...box, url };
}

const frame = (url: string, path: string, site = "same-origin") =>
  new Request(`${url}/page/${sandboxFileUrlPath(path)}`, {
    headers: { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": site },
  });
const sub = (url: string, path: string, dest: string, site = "cross-site") =>
  new Request(`${url}/page/${sandboxFileUrlPath(path)}`, {
    headers: { "Sec-Fetch-Dest": dest, "Sec-Fetch-Site": site },
  });

describe("a multi-file page's wrapper", () => {
  test("frames the entry file, each path segment percent-encoded", async () => {
    const { service, url } = await opened();
    const body = await (await service.serve(new Request(url))).text();
    expect(body).toContain(
      `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src="${new URL(url).pathname}/page/home%20page.html">`,
    );
  });

  test("a link is not given for a version with no web page entry within the limit", async () => {
    const big = { entryPath: "a.html", files: { "a.html": "x".repeat(2 * 1024 * 1024 + 1) } };
    await expect(sandbox(big).service.link(linkInput)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the page's own file prefix in its CSP", () => {
  test("an html file gets its ticket's file prefix, and still sandbox, no connection, no form", async () => {
    const { service, url } = await opened();
    const response = await service.serve(frame(url, "home page.html"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("css/site.css");
    const csp = Object.fromEntries(
      (response.headers.get("content-security-policy") ?? "").split("; ").map((directive) => {
        const [name, ...sources] = directive.split(" ");
        return [name!, sources.join(" ")];
      }),
    );
    const prefix = `${SANDBOX}/a/${ticketOf(url)}/page/`;
    for (const name of ["script-src", "style-src", "img-src", "font-src", "media-src"])
      expect(csp[name]!.split(" "), name).toContain(prefix);
    expect(csp["script-src"]).toContain("'unsafe-inline'");
    expect(csp["style-src"]).toContain("'unsafe-inline'");
    expect(csp["sandbox"]).toBe("allow-scripts");
    expect(csp["default-src"]).toBe("'none'");
    expect(csp["connect-src"]).toBe("'none'");
    expect(csp["form-action"]).toBe("'none'");
    expect(csp["base-uri"]).toBe("'none'");
    expect(csp["webrtc"]).toBe("'block'");
    expect(csp["frame-ancestors"]).toBe(`${SANDBOX} ${APP}`);
    // The frame stays closed, and no directive but those five carries the prefix.
    expect(csp["frame-src"]).toBeUndefined();
    expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    for (const [name, sources] of Object.entries(csp))
      if (!["script-src", "style-src", "img-src", "font-src", "media-src"].includes(name))
        expect(sources, name).not.toContain(prefix);
  });

  test("another ticket's prefix is not in it", async () => {
    const one = await opened();
    const other = sandbox();
    const second = await other.service.link({ ...linkInput, artifactId: "a2" });
    const csp = (await one.service.serve(frame(one.url, "other.html"))).headers.get(
      "content-security-policy",
    )!;
    expect(csp).toContain(`${SANDBOX}/a/${ticketOf(one.url)}/page/`);
    expect(csp).not.toContain(ticketOf(second.url));
  });
});

describe("a file that is not html", () => {
  test("is served with a type from its extension, nosniff, and a CSP that lets it do nothing", async () => {
    const { service, url } = await opened();
    const cases: [string, string, string][] = [
      ["css/site.css", "style", "text/css; charset=utf-8"],
      ["app.js", "script", "text/javascript; charset=utf-8"],
      ["img/a.png", "image", "image/png"],
      ["fonts/x.woff2", "font", "font/woff2"],
      ["data.unknownext", "video", "application/octet-stream"],
    ];
    for (const [path, dest, type] of cases) {
      const response = await service.serve(sub(url, path, dest));
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toBe(type);
      expect(await response.text()).toBe(site().files[path]!);
      expect(response.headers.get("content-length")).toBe(
        String(text(site().files[path]!).byteLength),
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      // A signed link pins one version, so its files do not change under it.
      expect(response.headers.get("cache-control")).toBe("private, max-age=1800, immutable");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
      // No WebRTC script in front of a file that is not a page.
      expect(response.headers.get("content-type")).not.toContain("html");
    }
  });

  test("answers a module script's and a font's CORS request from the page's opaque origin", async () => {
    const { service, url } = await opened();
    const response = await service.serve(
      new Request(`${url}/page/app.js`, {
        headers: {
          "Sec-Fetch-Dest": "script",
          "Sec-Fetch-Site": "cross-site",
          "Sec-Fetch-Mode": "cors",
          Origin: "null",
        },
      }),
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("null");
  });

  test("HEAD has the headers and no body", async () => {
    const { service, url } = await opened();
    const head = await service.serve(
      new Request(`${url}/page/app.js`, {
        method: "HEAD",
        headers: { "Sec-Fetch-Dest": "script", "Sec-Fetch-Site": "cross-site" },
      }),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await head.text()).toBe("");
  });

  test("is only a subresource: never a document, a frame, or a request with no fetch metadata", async () => {
    const { service, url } = await opened();
    const refused: Record<string, string>[] = [
      {},
      { "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "none" },
      { "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Dest": "frame", "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Dest": "embed", "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Dest": "object", "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Dest": "worker", "Sec-Fetch-Site": "cross-site" },
      // A fetch or XHR (`connect-src` stops a page making one; the sandbox does not serve one).
      { "Sec-Fetch-Dest": "empty", "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Dest": "empty", "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Site": "cross-site" },
    ];
    for (const headers of refused)
      expect(
        (await service.serve(new Request(`${url}/page/css/site.css`, { headers }))).status,
      ).toBe(404);
    for (const dest of ["script", "style", "image", "font", "audio", "video", "track"])
      for (const site of ["same-origin", "cross-site"])
        expect((await service.serve(sub(url, "css/site.css", dest, site))).status, dest).toBe(200);
  });
});

describe("an html file", () => {
  test("is only a frame document: the wrapper's, or a navigation of a frame (never a document)", async () => {
    const { service, url } = await opened();
    // The wrapper's frame, and a link followed inside it (the browser sends an opaque-origin
    // document's navigation as cross-site).
    expect((await service.serve(frame(url, "other.html"))).status).toBe(200);
    expect((await service.serve(frame(url, "other.html", "cross-site"))).status).toBe(200);
    expect((await service.serve(frame(url, "other.html"))).headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    const refused: Record<string, string>[] = [
      {},
      { "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "none" },
      { "Sec-Fetch-Dest": "script", "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "same-site" },
      { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "none" },
      { "Sec-Fetch-Dest": "iframe" },
    ];
    for (const headers of refused)
      expect((await service.serve(new Request(`${url}/page/other.html`, { headers }))).status).toBe(
        404,
      );
  });

  test("is never cached: each load asks again whether its reader may still read it", async () => {
    const { service, url } = await opened();
    const served = await service.serve(frame(url, "other.html"));
    expect(served.headers.get("cache-control")).toBe("no-store");
    expect((await service.serve(new Request(url))).headers.get("cache-control")).toBe("no-store");
  });

  test("gets WebRTC removed first, whatever its name", async () => {
    const { service, url } = await opened();
    for (const path of ["home page.html", "other.html"]) {
      const served = await (await service.serve(frame(url, path))).text();
      expect(served).toStartWith("<!doctype html><script>");
      expect(served).toContain("RTCPeerConnection");
    }
  });
});

describe("what a ticket reaches", () => {
  test("a missing file is a 404, and so is a path that cannot name one, with no lookup", async () => {
    const { service, url, lookups } = await opened();
    expect((await service.serve(sub(url, "nope.css", "style"))).status).toBe(404);
    expect(lookups).toEqual(["nope.css"]);
    lookups.length = 0;
    const base = `${url}/page/`;
    for (const tail of ["..%2f..%2fx.css", "%2e%2e/x.css", "a%5Cb.css", "%ZZ", "a//b.css", ""])
      expect(
        (
          await service.serve(
            new Request(base + tail, {
              headers: { "Sec-Fetch-Dest": "style", "Sec-Fetch-Site": "cross-site" },
            }),
          )
        ).status,
        tail,
      ).toBe(404);
    expect(lookups).toEqual([]);
  });

  test("the old frame path, with no file named, opens nothing", async () => {
    const { service, url } = await opened();
    const headers = { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "same-origin" };
    expect((await service.serve(new Request(`${url}/page`, { headers }))).status).toBe(404);
    expect((await service.serve(new Request(`${url}/page/`, { headers }))).status).toBe(404);
  });

  test("a file stops opening once its reader loses access", async () => {
    let readable = true;
    const { service, url } = await opened(undefined, { readable: () => readable });
    expect((await service.serve(sub(url, "app.js", "script"))).status).toBe(200);
    readable = false;
    expect((await service.serve(sub(url, "app.js", "script"))).status).toBe(404);
    expect((await service.serve(frame(url, "other.html"))).status).toBe(404);
  });

  test("a file opens for 30 minutes after the link was made; the wrapper for 5", async () => {
    expect(SANDBOX_FILE_TTL_SECONDS).toBe(30 * 60);
    expect(SANDBOX_TICKET_TTL_SECONDS).toBe(5 * 60);
    const { service, url, at } = await opened();
    at(SANDBOX_TICKET_TTL_SECONDS * 1000);
    expect((await service.serve(new Request(url))).status).toBe(403);
    at(29 * 60 * 1000);
    expect((await service.serve(sub(url, "img/a.png", "image"))).status).toBe(200);
    expect((await service.serve(frame(url, "other.html", "cross-site"))).status).toBe(200);
    at(30 * 60 * 1000);
    const late = await service.serve(sub(url, "img/a.png", "image"));
    expect(late.status).toBe(403);
    expect(await late.text()).toContain("expired");
    expect((await service.serve(frame(url, "other.html", "cross-site"))).status).toBe(403);
  });

  test("a link's own expiry is the wrapper's: five minutes", async () => {
    const box = sandbox();
    const link = await box.service.link(linkInput);
    expect(link.expiresAt.getTime()).toBe(NOW.getTime() + SANDBOX_TICKET_TTL_SECONDS * 1000);
  });
});
