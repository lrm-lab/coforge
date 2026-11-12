import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  ArtifactSandboxConfigError,
  isSandboxRequest,
  readArtifactSandboxConfig,
} from "#src/server/artifacts/artifact-sandbox-config.server";
import {
  readSandboxTicket,
  SANDBOX_FILE_TTL_SECONDS,
  SANDBOX_TICKET_TTL_SECONDS,
  signSandboxTicket,
} from "#src/server/artifacts/artifact-sandbox-ticket.server";
import { ArtifactSandbox } from "#src/server/artifacts/artifact-sandbox.server";
import { ARTIFACT_HTML_LIMIT } from "#src/server/artifacts/artifact-sandbox-files.server";
import { withWebRtcOff } from "#src/server/artifacts/artifact-sandbox-response.server";
import { signValue } from "#src/server/auth/signed-value.server";
import { AppError } from "#src/lib/app-error";

/**
 * Web pages on their own origin (task #490): the sandbox origin's configuration, the signed
 * link, and what the sandbox answers — the page with headers that let its scripts run and nothing
 * leave, or a refusal. Several files per page are `artifact-sandbox-files.test.ts`, the public
 * hosts a page may load from `artifact-sandbox-cdns.test.ts`. The browser's side of those headers is
 * `artifact-sandbox-browser.e2e.ts`; real reads and access are `artifact-sandbox.integration.ts`.
 */

const SECRET = "s".repeat(40);
const SANDBOX = "https://sandbox.example";
const APP = "https://app.example";
const NOW = new Date("2026-11-04T08:00:00Z");
const PAGE = new TextEncoder().encode("<!doctype html><p>hi</p>");

describe("the sandbox origin's configuration", () => {
  test("is off when unset", () => {
    expect(readArtifactSandboxConfig({})).toBeNull();
    expect(readArtifactSandboxConfig({ COFORGE_ARTIFACT_SANDBOX_ORIGIN: "  " })).toBeNull();
  });

  test("is an https origin, a trailing slash normalised away", () => {
    expect(
      readArtifactSandboxConfig({
        COFORGE_ARTIFACT_SANDBOX_ORIGIN: "https://coforgeusercontent.com/",
      }),
    ).toEqual({ origin: "https://coforgeusercontent.com" });
  });

  test("allows plain http only on a loopback host", () => {
    expect(
      readArtifactSandboxConfig({ COFORGE_ARTIFACT_SANDBOX_ORIGIN: "http://127.0.0.1:5199" }),
    ).toEqual({ origin: "http://127.0.0.1:5199" });
    expect(() =>
      readArtifactSandboxConfig({ COFORGE_ARTIFACT_SANDBOX_ORIGIN: "http://sandbox.example" }),
    ).toThrow(ArtifactSandboxConfigError);
  });

  test("refuses a path, a query, or the application's own origin", () => {
    for (const value of ["https://sandbox.example/pages", "https://sandbox.example/?x=1", "nope"])
      expect(() => readArtifactSandboxConfig({ COFORGE_ARTIFACT_SANDBOX_ORIGIN: value })).toThrow(
        ArtifactSandboxConfigError,
      );
  });

  test("refuses the application's own host, by any setting naming it", () => {
    const refused = [
      [APP, { COFORGE_OIDC_ISSUER: `${APP}/oidc` }, "must not be the application's own host"],
      // Another port is still the same host: the gate matches by name.
      ["https://app.example:8443", { COFORGE_OIDC_ISSUER: `${APP}/oidc` }, "own host"],
      // Named by the GitHub callback alone.
      [APP, { COFORGE_GITHUB_CALLBACK_URL: `${APP}/auth/github/callback` }, "own host"],
    ] as const;
    for (const [origin, env, message] of refused)
      expect(() =>
        readArtifactSandboxConfig({ COFORGE_ARTIFACT_SANDBOX_ORIGIN: origin, ...env }, () => {}),
      ).toThrow(message);
  });

  test("allows a subdomain of the application (task #544): cookies stay host-only", () => {
    for (const origin of [
      "https://usercontent.app.example",
      // A parent too: nothing host-only reaches up or down, and the page is an opaque origin.
      "https://example",
    ])
      expect(() =>
        readArtifactSandboxConfig(
          { COFORGE_ARTIFACT_SANDBOX_ORIGIN: origin, COFORGE_OIDC_ISSUER: `${APP}/oidc` },
          () => {},
        ),
      ).not.toThrow();
  });

  test("no cookie the application sets carries a Domain attribute", async () => {
    // The sandbox may be a subdomain of the application only while every cookie stays
    // host-only: a `Domain=` attribute would send it to the sandbox too (task #544).
    const web = resolve(import.meta.dir, "..");
    const violations: string[] = [];
    for await (const path of new Bun.Glob("src/**/*.{ts,tsx}").scan(web)) {
      const source = await Bun.file(resolve(web, path)).text();
      // A cookie attribute sits after a quote or `;` in the cookie string; a bare `domain =`
      // in code or prose is not one.
      for (const match of source.matchAll(/[;"'`]\s*domain\s*=/gi))
        violations.push(`${path}: ${match[0].trim()}`);
    }
    expect(violations, "A cookie with Domain reaches the sandbox subdomain").toEqual([]);
  });

  test("with nothing naming the application, boots with a warning", () => {
    const warnings: string[] = [];
    expect(
      readArtifactSandboxConfig({ COFORGE_ARTIFACT_SANDBOX_ORIGIN: SANDBOX }, (w) =>
        warnings.push(w),
      ),
    ).toEqual({ origin: SANDBOX });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("artifact_sandbox_origin_unchecked");
  });

  test("a request is the sandbox's by its host name alone", () => {
    expect(isSandboxRequest(new Request("http://sandbox.example/a/x.y"), SANDBOX)).toBe(true);
    expect(isSandboxRequest(new Request(`${APP}/a/x.y`), SANDBOX)).toBe(false);
    expect(isSandboxRequest(new Request("http://sandbox.example/"), null)).toBe(false);
    // A fully qualified spelling, a spelled-out port, or capitals: the same host.
    expect(isSandboxRequest(new Request("http://sandbox.example./a/x.y"), SANDBOX)).toBe(true);
    expect(isSandboxRequest(new Request("http://sandbox.example:443/"), SANDBOX)).toBe(true);
    expect(isSandboxRequest(new Request("http://SANDBOX.example/"), SANDBOX)).toBe(true);
  });
});

describe("a sandbox ticket", () => {
  const grant = { w: "w1", a: "a1", v: 3, u: "u1", o: APP };

  test("reads back what was signed; its files open for 30 minutes, the wrapper for 5", () => {
    const { ticket, expiresAt } = signSandboxTicket(grant, SECRET, NOW);
    expect(expiresAt.getTime()).toBe(NOW.getTime() + SANDBOX_TICKET_TTL_SECONDS * 1000);
    expect(readSandboxTicket(ticket, SECRET, NOW)).toMatchObject({
      ...grant,
      iat: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + SANDBOX_FILE_TTL_SECONDS,
    });
    expect(readSandboxTicket(ticket, SECRET, expiresAt)).toMatchObject(grant);
    const filesEnd = new Date(NOW.getTime() + SANDBOX_FILE_TTL_SECONDS * 1000);
    expect(readSandboxTicket(ticket, SECRET, new Date(filesEnd.getTime() - 1))).not.toBe("expired");
    expect(readSandboxTicket(ticket, SECRET, filesEnd)).toBe("expired");
  });

  test("is refused when changed, signed with another secret, or signed for another purpose", () => {
    const { ticket } = signSandboxTicket(grant, SECRET, NOW);
    const [body, signature] = ticket.split(".");
    const forged = Buffer.from(JSON.stringify({ ...grant, u: "u2", exp: 9e9 })).toString(
      "base64url",
    );
    expect(readSandboxTicket(`${forged}.${signature}`, SECRET, NOW)).toBeNull();
    expect(readSandboxTicket(`${body}.${signature}x`, SECRET, NOW)).toBeNull();
    expect(readSandboxTicket(ticket, "t".repeat(40), NOW)).toBeNull();
    // A session signed with the same secret is not a ticket.
    const session = signValue("session", { ...grant, exp: 9e9 }, SECRET);
    expect(readSandboxTicket(session, SECRET, NOW)).toBeNull();
  });
});

type Page = { entryPath?: string; sizeBytes?: number; number?: number };

const entry = (page: Page, number: number) => ({
  path: page.entryPath ?? "index.html",
  sha256: `sha-${number}`,
  sizeBytes: page.sizeBytes ?? PAGE.byteLength,
  kind: "html",
});

/** A sandbox over one readable page (unless `readable` says otherwise), at a fixed time. */
function sandbox(
  page: Page = {},
  options: { origin?: string | null; readable?: () => boolean; bytes?: Uint8Array } = {},
) {
  const reads = {
    read: async (input: { reader: { userId?: string }; version?: number }) => {
      if (options.readable && !options.readable()) throw new AppError("NOT_FOUND");
      const number = input.version ?? page.number ?? 2;
      return {
        artifact: { currentVersion: page.number ?? 2 },
        version: { number, entryPath: page.entryPath ?? "index.html" },
        files: [entry(page, number)],
      };
    },
    file: async (input: { path: string; version?: number }) => {
      if (options.readable && !options.readable()) throw new AppError("NOT_FOUND");
      const row = entry(page, input.version ?? page.number ?? 2);
      return input.path === row.path ? row : null;
    },
  };
  let now = NOW;
  const service = new ArtifactSandbox({
    reads: reads as never,
    readBlob: async () => options.bytes ?? PAGE,
    origin: options.origin === undefined ? SANDBOX : options.origin,
    secret: async () => SECRET,
    now: () => now,
  });
  return { service, later: (ms: number) => (now = new Date(NOW.getTime() + ms)) };
}

const linkInput = { workspaceId: "w1", userId: "u1", artifactId: "a1", embedderOrigin: APP };

describe("a web page's link", () => {
  test("is on the sandbox origin, pinned to the current version", async () => {
    const { service } = sandbox({ number: 4 });
    const link = await service.link(linkInput);
    expect(link.url.startsWith(`${SANDBOX}/a/`)).toBe(true);
    expect(link.version).toBe(4);
    const ticket = readSandboxTicket(link.url.slice(`${SANDBOX}/a/`.length), SECRET, NOW);
    expect(ticket).toMatchObject({ w: "w1", a: "a1", v: 4, u: "u1", o: APP });
  });

  test("is refused with no sandbox origin, or one on the application's own host", async () => {
    await expect(sandbox({}, { origin: null }).service.link(linkInput)).rejects.toMatchObject({
      errorId: "artifact-sandbox-off",
    });
    await expect(
      sandbox({}, { origin: "https://app.example" }).service.link(linkInput),
    ).rejects.toMatchObject({ errorId: "artifact-sandbox-off" });
  });

  test("is not given for a document (a Markdown entry), nor a page whose entry is over 2 MiB", async () => {
    for (const page of [{ entryPath: "document.md" }, { sizeBytes: ARTIFACT_HTML_LIMIT + 1 }])
      await expect(sandbox(page).service.link(linkInput)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
  });
});

describe("the sandbox's answer", () => {
  async function opened(page: Page = {}, options: Parameters<typeof sandbox>[1] = {}) {
    const box = sandbox(page, options);
    const { url } = await box.service.link(linkInput);
    return { ...box, url };
  }

  const frame = (url: string, init: RequestInit = {}) =>
    new Request(`${url}/page/index.html`, {
      ...init,
      headers: { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "same-origin" },
    });

  test("a link is our wrapper, framing the page sandboxed, framed by the app alone", async () => {
    const { service, url } = await opened();
    const response = await service.serve(new Request(url));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(
      `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src="${new URL(url).pathname}/page/index.html">`,
    );
    const csp = (response.headers.get("content-security-policy") ?? "").split("; ");
    const nonce = /script-src 'nonce-([0-9a-f]+)'/.exec(csp.join("; "))?.[1];
    expect(nonce).toBeDefined();
    expect(csp).toEqual([
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      `frame-src ${SANDBOX}`,
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      `frame-ancestors ${APP}`,
    ]);
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    // A fresh nonce each time.
    const again = await service.serve(new Request(url));
    expect(again.headers.get("content-security-policy")).not.toContain(nonce!);
  });

  test("the page is served only as a frame: never a document of its own, nor a same-site app's frame", async () => {
    const { service, url } = await opened();
    const cases: Record<string, string>[] = [
      {},
      { "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Dest": "script", "Sec-Fetch-Site": "same-origin" },
      // Framed by a same-site app directly, out from under the wrapper. (A cross-site frame is
      // also what a link followed inside the opaque frame is: `artifact-sandbox-files.test.ts`.)
      { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "same-site" },
      { "Sec-Fetch-Dest": "iframe" },
    ];
    for (const headers of cases) {
      expect((await service.serve(new Request(`${url}/page/index.html`, { headers }))).status).toBe(
        404,
      );
    }
  });

  test("the framed page, with its scripts allowed and nothing else", async () => {
    const { service, url } = await opened();
    const response = await service.serve(frame(url));
    expect(response.status).toBe(200);
    const served = await response.text();
    // WebRTC removed first, after the doctype; then the page as it was written.
    expect(served).toStartWith("<!doctype html><script>");
    expect(served).toContain("RTCPeerConnection");
    expect(served).toEndWith(new TextDecoder().decode(PAGE).slice("<!doctype html>".length));
    expect(response.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(served).byteLength),
    );
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = (response.headers.get("content-security-policy") ?? "").split("; ");
    const prefix = `${SANDBOX}/a/${new URL(url).pathname.slice("/a/".length)}/page/`;
    // Each directive starts with what a page always had; the page's own files (and, in
    // `artifact-sandbox-cdns.test.ts`, the public hosts) come after.
    const starts = [
      "sandbox allow-scripts",
      "default-src 'none'",
      "script-src 'unsafe-inline' " + prefix,
      "style-src 'unsafe-inline' " + prefix,
      "img-src data: blob: " + prefix,
      "font-src data: " + prefix,
      "media-src data: blob: " + prefix,
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "webrtc 'block'",
      `frame-ancestors ${SANDBOX} ${APP}`,
    ];
    expect(csp).toHaveLength(starts.length);
    starts.forEach((start, index) => expect(csp[index]).toStartWith(start));
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("HEAD has the headers and no body; other methods are refused", async () => {
    const { service, url } = await opened();
    const head = await service.serve(frame(url, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await service.serve(new Request(url, { method: "POST" }))).status).toBe(405);
  });

  test("anything but a valid link is a refusal that runs nothing", async () => {
    const { service, url } = await opened();
    for (const path of [
      "/",
      "/a/",
      "/a/nope",
      "/api/me",
      "/w/acme",
      `${new URL(url).pathname}/x`,
      `${new URL(url).pathname}/page/x`,
      `${new URL(url).pathname}/page`,
    ]) {
      const response = await service.serve(new Request(`${SANDBOX}${path}`));
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("content-security-policy")).toContain("sandbox");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    }
  });

  test("an expired link says so", async () => {
    const { service, url, later } = await opened();
    later(SANDBOX_TICKET_TTL_SECONDS * 1000);
    const response = await service.serve(new Request(url));
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("expired");
  });

  test("a reader who lost access since the link was made gets nothing", async () => {
    let readable = true;
    const { service, url } = await opened({}, { readable: () => readable });
    readable = false;
    expect((await service.serve(new Request(url))).status).toBe(404);
    expect((await service.serve(frame(url))).status).toBe(404);
  });

  test("bytes over the limit are not served, whatever the row says", async () => {
    const { service, url } = await opened({}, { bytes: new Uint8Array(ARTIFACT_HTML_LIMIT + 1) });
    expect((await service.serve(frame(url))).status).toBe(404);
  });
});

describe("removing WebRTC from a page", () => {
  const text = (page: string) =>
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      withWebRtcOff(new TextEncoder().encode(page)),
    );

  test("goes after a leading doctype, so the page keeps its standards mode", () => {
    const out = text("\uFEFF  <!DOCTYPE html>\n<html><p>x</p></html>");
    expect(out).toStartWith("\uFEFF  <!DOCTYPE html><script>");
    expect(out).toEndWith("</script>\n<html><p>x</p></html>");
  });

  test("goes first when there is no doctype, before any script of the page's", () => {
    const out = text("<script>new RTCPeerConnection()</script>");
    expect(out.indexOf("Object.defineProperty")).toBeLessThan(out.indexOf("new RTCPeerConnection"));
    expect(out).toStartWith("<script>");
  });
});
