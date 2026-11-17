import { describe, expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import { ArtifactSandbox } from "#src/server/artifacts/artifact-sandbox.server";
import { MemoryTicketNonces } from "#src/server/artifacts/artifact-sandbox-nonces.server";
import { SANDBOX_FILE_TTL_SECONDS } from "#src/server/artifacts/artifact-sandbox-ticket.server";
import { sandboxFileUrlPath } from "#src/server/artifacts/artifact-sandbox-path.server";
import { FRAME, openLink, openPage, subresource } from "./helpers/artifact-sandbox-open";

const SECRET = "s".repeat(40);
const SANDBOX = "https://sandbox.example";
const APP = "https://app.example";
const A = "11111111-1111-4111-8111-111111111111";
const A_ORIGIN = `https://a-${A}.sandbox.example`;
const NOW = new Date("2026-11-04T08:00:00Z");
const text = (value: string) => new TextEncoder().encode(value);

const FILES: Record<string, string> = {
  "README.md": "# readme",
  "pages/two.html": '<!doctype html><a href="three.html">three</a>',
  "pages/three.html": "<!doctype html><p>three</p>",
  "docs/paper.pdf": "%PDF-1.4 bytes",
  "notes.txt": "notes",
};

function sandbox(entryPath = "README.md", now = () => NOW) {
  const row = (path: string) => ({
    path,
    sha256: `sha:${path}`,
    sizeBytes: text(FILES[path]!).byteLength,
    kind: "text",
  });
  const reads = {
    read: async () => ({
      artifact: { currentVersion: 3, canChange: false },
      version: { number: 3, entryPath },
      files: Object.keys(FILES).map(row),
    }),
    file: async (input: { path: string }) => (input.path in FILES ? row(input.path) : null),
    fileInVersion: async (input: { path: string }) =>
      input.path in FILES ? row(input.path) : null,
  };
  return new ArtifactSandbox({
    reads: reads as never,
    readBlob: async (_workspaceId, sha256) => text(FILES[sha256.slice(4)] ?? ""),
    origin: SANDBOX,
    nonces: new MemoryTicketNonces(() => NOW.getTime()),
    secret: async () => SECRET,
    now,
  });
}

const linkInput = { workspaceId: "w1", userId: "u1", artifactId: A, embedderOrigin: APP };

async function opened(path?: string, entryPath?: string) {
  const service = sandbox(entryPath);
  const { url } = await service.link({ ...linkInput, path });
  return { service, ...(await openPage(service, url)) };
}

describe("a non-entry html file", () => {
  test("opens as a page of its own on the artifact's origin, whatever the entry is", async () => {
    const { response, filesUrl } = await opened("pages/two.html");
    expect(filesUrl.startsWith(`${A_ORIGIN}/_f/`)).toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain("sandbox allow-scripts allow-same-origin");
    expect(csp).toContain(`frame-ancestors ${APP}`);
    expect(await response.text()).toContain("/_coforge/runtime.js");
  });

  test("resolves a relative link against its own path, inside the version", async () => {
    const { service, filesUrl } = await opened("pages/two.html");
    const next = await service.serve(
      new Request(new URL("three.html", `${filesUrl}pages/two.html`), { headers: FRAME }),
    );
    expect(await next.text()).toContain("<p>three</p>");
    const outside = await service.serve(
      new Request(`${filesUrl}pages/..%2Fsecret.html`, { headers: FRAME }),
    );
    expect(outside.status).toBe(404);
  });

  test("is refused for a path the version does not hold or that is no page or PDF", async () => {
    const service = sandbox();
    for (const path of ["missing.html", "notes.txt", "../x.html", "pages//two.html"])
      await expect(service.link({ ...linkInput, path }), path).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
  });

  test("a ticket for one file redirects to that file", async () => {
    const service = sandbox();
    const { url } = await service.link({ ...linkInput, path: "pages/two.html" });
    const redirect = await openLink(service, url);
    expect(new URL(redirect.headers.get("location")!, url).pathname).toEndWith(
      `/${sandboxFileUrlPath("pages/two.html")}`,
    );
  });
});

describe("a PDF file", () => {
  test("is a frame document of its bytes, with a policy that allows nothing else, never cached", async () => {
    const { response } = await opened("docs/paper.pdf");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toBe(`default-src 'none'; frame-ancestors ${APP}`);
    expect(await response.text()).toBe(FILES["docs/paper.pdf"]);
  });

  test("reloaded once its token has expired, tells the framing app so it can open it again", async () => {
    let now = NOW;
    const service = sandbox(undefined, () => now);
    const { url } = await service.link({ ...linkInput, path: "docs/paper.pdf" });
    const { filesUrl } = await openPage(service, url);
    now = new Date(NOW.getTime() + SANDBOX_FILE_TTL_SECONDS * 1000);
    const late = await service.serve(new Request(`${filesUrl}docs/paper.pdf`, { headers: FRAME }));
    expect(late.status).toBe(403);
    const page = await late.text();
    expect(page).toContain('"method":"coforge/notifications/frame-status"');
    expect(page).toContain('"reason":"expired"');
    expect(page).toContain(JSON.stringify(APP));
    const asset = await service.serve(
      new Request(`${filesUrl}docs/paper.pdf`, { headers: subresource("empty") }),
    );
    expect(asset.status).toBe(403);
    expect(await asset.text()).not.toContain("frame-status");
  });

  test("is still served as a subresource under the sandboxed policy", async () => {
    const { service, filesUrl } = await opened("docs/paper.pdf");
    const response = await service.serve(
      new Request(`${filesUrl}docs/paper.pdf`, { headers: subresource("empty") }),
    );
    expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  });

  test("is not a document for a file the page never opened as one", async () => {
    const { service, filesUrl } = await opened("docs/paper.pdf");
    const text = await service.serve(new Request(`${filesUrl}notes.txt`, { headers: FRAME }));
    expect(text.status).toBe(404);
  });

  test("a refused read ends the open", async () => {
    const service = new ArtifactSandbox({
      reads: {
        read: async () => {
          throw new AppError("NOT_FOUND");
        },
      } as never,
      readBlob: async () => null,
      origin: SANDBOX,
      nonces: new MemoryTicketNonces(() => NOW.getTime()),
      secret: async () => SECRET,
      now: () => NOW,
    });
    await expect(service.link({ ...linkInput, path: "docs/paper.pdf" })).rejects.toBeInstanceOf(
      AppError,
    );
  });
});
