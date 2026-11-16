import { describe, expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import {
  decodeSandboxFilePath,
  sandboxFileUrlPath,
} from "#src/server/artifacts/artifact-sandbox-path.server";
import { ArtifactSandbox } from "#src/server/artifacts/artifact-sandbox.server";
import { MemoryTicketNonces } from "#src/server/artifacts/artifact-sandbox-nonces.server";
import { SANDBOX_FILE_TTL_SECONDS } from "#src/server/artifacts/artifact-sandbox-ticket.server";
import { FRAME, openPage, subresource } from "./helpers/artifact-sandbox-open";

/**
 * A web page of several files on its artifact's origin: every file of the opened version is served
 * under the file token's prefix (`/_f/<token>/<path>`), an `.html` file as a document only for a
 * frame or a tab, any other file only as a subresource, and the token's reach in time and in
 * files. The browser's side is `artifact-sandbox-browser.e2e.ts`; real reads are
 * `artifact-sandbox.integration.ts`.
 */

const SECRET = "s".repeat(40);
const SANDBOX = "https://sandbox.example";
const APP = "https://app.example";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
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
    fileInVersion: async (input: { path: string }) => {
      lookups.push(input.path);
      return input.path in version.files
        ? { sha256: `sha:${input.path}`, sizeBytes: text(version.files[input.path]!).byteLength }
        : null;
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
    nonces: new MemoryTicketNonces(() => now.getTime()),
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

const linkInput = { workspaceId: "w1", userId: "u1", artifactId: A, embedderOrigin: APP };

async function opened(version?: Version, options?: Parameters<typeof sandbox>[1]) {
  const box = sandbox(version, options);
  const { url } = await box.service.link(linkInput);
  const { filesUrl } = await openPage(box.service, url);
  return { ...box, url, filesUrl };
}

const frame = (filesUrl: string, path: string) =>
  new Request(`${filesUrl}${sandboxFileUrlPath(path)}`, { headers: FRAME });
const sub = (filesUrl: string, path: string, dest: string) =>
  new Request(`${filesUrl}${sandboxFileUrlPath(path)}`, { headers: subresource(dest) });

describe("opening a multi-file page", () => {
  test("lands on the entry file, each path segment percent-encoded", async () => {
    const box = sandbox();
    const { url } = await box.service.link(linkInput);
    const redirect = await box.service.serve(new Request(url, { headers: FRAME }));
    expect(redirect.headers.get("location")).toEndWith("/home%20page.html");
  });

  test("a link is not given for a version with no web page entry within the limit", async () => {
    const big = { entryPath: "a.html", files: { "a.html": "x".repeat(2 * 1024 * 1024 + 1) } };
    await expect(sandbox(big).service.link(linkInput)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the page's own file prefix in its CSP", () => {
  test("an html document names its token's prefix for what it may load and fetch, and nothing wider", async () => {
    const { service, filesUrl } = await opened();
    const response = await service.serve(frame(filesUrl, "home page.html"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("css/site.css");
    const csp = Object.fromEntries(
      (response.headers.get("content-security-policy") ?? "").split("; ").map((directive) => {
        const [name, ...sources] = directive.split(" ");
        return [name!, sources];
      }),
    );
    const withPrefix = [
      "script-src",
      "style-src",
      "img-src",
      "font-src",
      "media-src",
      "connect-src",
      "worker-src",
    ];
    for (const name of withPrefix) expect(csp[name], name).toContain(filesUrl);
    for (const [name, sources] of Object.entries(csp))
      if (!withPrefix.includes(name)) expect(sources, name).not.toContain(filesUrl);
    expect(csp["sandbox"]).toEqual(["allow-scripts", "allow-same-origin"]);
    expect(csp["frame-ancestors"]).toEqual([APP]);
    expect(csp["frame-src"]).toEqual(["'none'"]);
    expect(JSON.stringify(csp)).not.toContain("*");
  });

  test("another artifact's prefix is not in it", async () => {
    const one = await opened();
    const otherBox = sandbox();
    const other = await openPage(
      otherBox.service,
      (await otherBox.service.link({ ...linkInput, artifactId: B })).url,
    );
    const csp = (await one.service.serve(frame(one.filesUrl, "other.html"))).headers.get(
      "content-security-policy",
    )!;
    expect(csp).toContain(one.filesUrl);
    expect(csp).not.toContain(new URL(other.filesUrl).host);
  });
});

describe("a file that is not html", () => {
  test("is served with a type from its extension, nosniff, and a CSP that lets it do nothing", async () => {
    const { service, filesUrl } = await opened();
    const cases: [string, string, string][] = [
      ["css/site.css", "style", "text/css; charset=utf-8"],
      ["app.js", "script", "text/javascript; charset=utf-8"],
      ["img/a.png", "image", "image/png"],
      ["fonts/x.woff2", "font", "font/woff2"],
      ["data.unknownext", "video", "application/octet-stream"],
    ];
    for (const [path, dest, type] of cases) {
      const response = await service.serve(sub(filesUrl, path, dest));
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toBe(type);
      expect(await response.text()).toBe(site().files[path]!);
      expect(response.headers.get("content-length")).toBe(
        String(text(site().files[path]!).byteLength),
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBe("private, max-age=600, immutable");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    }
  });

  test("HEAD has the headers and no body", async () => {
    const { service, filesUrl } = await opened();
    const head = await service.serve(
      new Request(`${filesUrl}app.js`, { method: "HEAD", headers: subresource("script") }),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await head.text()).toBe("");
  });

  test("is only a subresource: never a document, a frame, or a request with no fetch metadata", async () => {
    const { service, filesUrl } = await opened();
    const refused: Record<string, string>[] = [
      {},
      { "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "none" },
      { "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Dest": "frame", "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Dest": "embed", "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Dest": "object", "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Site": "same-origin" },
    ];
    for (const headers of refused)
      expect(
        (await service.serve(new Request(`${filesUrl}css/site.css`, { headers }))).status,
      ).toBe(404);
    const allowed = [
      "script",
      "style",
      "image",
      "font",
      "audio",
      "video",
      "track",
      "empty",
      "worker",
    ];
    for (const dest of allowed)
      expect((await service.serve(sub(filesUrl, "css/site.css", dest))).status, dest).toBe(200);
  });
});

describe("an html file", () => {
  test("is a document for a frame or a tab; for a fetch it is the bytes, with no page headers", async () => {
    const { service, filesUrl } = await opened();
    const document = await service.serve(frame(filesUrl, "other.html"));
    expect(document.status).toBe(200);
    expect(document.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(document.headers.get("content-security-policy")).toContain("frame-ancestors");
    expect(await document.text()).toContain("runtime.js");
    const fetched = await service.serve(sub(filesUrl, "other.html", "empty"));
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe("<!doctype html><p>other</p>");
    const refused: Record<string, string>[] = [
      {},
      { "Sec-Fetch-Dest": "embed" },
      { "Sec-Fetch-Dest": "object" },
    ];
    for (const headers of refused)
      expect((await service.serve(new Request(`${filesUrl}other.html`, { headers }))).status).toBe(
        404,
      );
    const tab = await service.serve(
      new Request(`${filesUrl}other.html`, { headers: { "Sec-Fetch-Dest": "document" } }),
    );
    expect(tab.status).toBe(200);
  });

  test("is never cached: each load asks again whether its reader may still read it", async () => {
    const { service, filesUrl } = await opened();
    const served = await service.serve(frame(filesUrl, "other.html"));
    expect(served.headers.get("cache-control")).toBe("no-store");
  });

  test("gets the runtime first, whatever its name", async () => {
    const { service, filesUrl } = await opened();
    for (const path of ["home page.html", "other.html"]) {
      const served = await (await service.serve(frame(filesUrl, path))).text();
      expect(served).toStartWith('<!doctype html><script src="/_coforge/runtime.js"');
    }
  });
});

describe("what a file token reaches", () => {
  test("a missing file is a 404, and so is a path that cannot name one, with no lookup", async () => {
    const { service, filesUrl, lookups } = await opened();
    lookups.length = 0;
    expect((await service.serve(sub(filesUrl, "nope.css", "style"))).status).toBe(404);
    expect(lookups).toEqual(["nope.css"]);
    lookups.length = 0;
    for (const tail of ["..%2f..%2fx.css", "%2e%2e/x.css", "a%5Cb.css", "%ZZ", "a//b.css", ""])
      expect(
        (await service.serve(new Request(filesUrl + tail, { headers: subresource("style") })))
          .status,
        tail,
      ).toBe(404);
    expect(lookups).toEqual([]);
  });

  test("a page stops opening once its reader loses access; a subresource serves under its token", async () => {
    let readable = true;
    const { service, filesUrl } = await opened(undefined, { readable: () => readable });
    expect((await service.serve(sub(filesUrl, "app.js", "script"))).status).toBe(200);
    readable = false;
    expect((await service.serve(sub(filesUrl, "app.js", "script"))).status).toBe(200);
    expect((await service.serve(frame(filesUrl, "other.html"))).status).toBe(404);
  });

  test("a file opens for 10 minutes after the page was opened", async () => {
    expect(SANDBOX_FILE_TTL_SECONDS).toBe(10 * 60);
    const { service, filesUrl, at } = await opened();
    at(9 * 60 * 1000);
    expect((await service.serve(sub(filesUrl, "img/a.png", "image"))).status).toBe(200);
    expect((await service.serve(frame(filesUrl, "other.html"))).status).toBe(200);
    at(10 * 60 * 1000);
    const late = await service.serve(sub(filesUrl, "img/a.png", "image"));
    expect(late.status).toBe(403);
    expect(await late.text()).toContain("expired");
    expect((await service.serve(frame(filesUrl, "other.html"))).status).toBe(403);
  });
});
