import { describe, expect, test } from "bun:test";
import {
  readSandboxFileToken,
  readSandboxTicket,
  SANDBOX_FILE_TTL_SECONDS,
  SANDBOX_TICKET_TTL_SECONDS,
  signSandboxFileToken,
  signSandboxTicket,
} from "#src/server/artifacts/artifact-sandbox-ticket.server";
import { ArtifactSandbox } from "#src/server/artifacts/artifact-sandbox.server";
import { ARTIFACT_HTML_LIMIT } from "#src/server/artifacts/artifact-sandbox-files.server";
import { MemoryTicketNonces } from "#src/server/artifacts/artifact-sandbox-nonces.server";
import { withPageRuntime } from "#src/server/artifacts/artifact-page-runtime.server";
import { signValue } from "#src/server/auth/signed-value.server";
import { AppError } from "#src/lib/app-error";
import { FRAME, openLink, openPage, subresource } from "./helpers/artifact-sandbox-open";

/**
 * Web pages on an origin per artifact: tickets and file tokens, and what the sandbox answers.
 * Several files per page are `artifact-sandbox-files.test.ts`, the configuration and host
 * recognition `artifact-sandbox-config.test.ts`, the public hosts a page may load from
 * `artifact-sandbox-cdns.test.ts`. The browser's side is `artifact-sandbox-browser.e2e.ts`; real
 * reads and access are `artifact-sandbox.integration.ts`.
 */

const SECRET = "s".repeat(40);
const SANDBOX = "https://sandbox.example";
const APP = "https://app.example";
const NOW = new Date("2026-11-04T08:00:00Z");
const PAGE = new TextEncoder().encode("<!doctype html><p>hi</p>");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const A_ORIGIN = `https://a-${A}.sandbox.example`;
const B_ORIGIN = `https://a-${B}.sandbox.example`;

describe("a sandbox ticket and its file token", () => {
  const grant = { w: "w1", a: A, v: 3, u: "u1", o: APP, s: A_ORIGIN };

  test("a ticket reads back what was signed, and is good for two minutes", () => {
    const { ticket, expiresAt } = signSandboxTicket(grant, SECRET, NOW);
    expect(expiresAt.getTime()).toBe(NOW.getTime() + SANDBOX_TICKET_TTL_SECONDS * 1000);
    expect(SANDBOX_TICKET_TTL_SECONDS).toBe(120);
    const read = readSandboxTicket(ticket, SECRET);
    expect(read).toMatchObject({
      ...grant,
      iat: NOW.getTime() / 1000,
      exp: expiresAt.getTime() / 1000,
    });
    expect(read?.n).toBeTruthy();
    expect(readSandboxTicket(signSandboxTicket(grant, SECRET, NOW).ticket, SECRET)?.n).not.toBe(
      read?.n,
    );
  });

  test("a file token is good for ten minutes", () => {
    const token = signSandboxFileToken(grant, SECRET, NOW);
    expect(SANDBOX_FILE_TTL_SECONDS).toBe(600);
    expect(readSandboxFileToken(token, SECRET)).toMatchObject({
      ...grant,
      exp: NOW.getTime() / 1000 + SANDBOX_FILE_TTL_SECONDS,
    });
  });

  test("is refused when changed, signed with another secret, or signed for another purpose", () => {
    const { ticket } = signSandboxTicket(grant, SECRET, NOW);
    const [body, signature] = ticket.split(".");
    const forged = Buffer.from(JSON.stringify({ ...grant, u: "u2", n: "x", exp: 9e9 })).toString(
      "base64url",
    );
    expect(readSandboxTicket(`${forged}.${signature}`, SECRET)).toBeNull();
    expect(readSandboxTicket(`${body}.${signature}x`, SECRET)).toBeNull();
    expect(readSandboxTicket(ticket, "t".repeat(40))).toBeNull();
    const session = signValue("session", { ...grant, n: "x", exp: 9e9 }, SECRET);
    expect(readSandboxTicket(session, SECRET)).toBeNull();
    expect(readSandboxFileToken(session, SECRET)).toBeNull();
  });

  test("a ticket is not a file token, nor a file token a ticket", () => {
    expect(readSandboxFileToken(signSandboxTicket(grant, SECRET, NOW).ticket, SECRET)).toBeNull();
    expect(readSandboxTicket(signSandboxFileToken(grant, SECRET, NOW), SECRET)).toBeNull();
  });
});

type Page = { entryPath?: string; sizeBytes?: number; number?: number };

const entry = (page: Page, number: number) => ({
  path: page.entryPath ?? "index.html",
  sha256: `sha-${number}`,
  sizeBytes: page.sizeBytes ?? PAGE.byteLength,
  kind: "html",
});

function sandbox(
  page: Page = {},
  options: {
    origin?: string | null;
    readable?: () => boolean;
    bytes?: Uint8Array;
    nonces?: { claim(nonce: string, ttl: number): Promise<boolean> };
  } = {},
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
    fileInVersion: async (input: { path: string }) => {
      const row = entry(page, page.number ?? 2);
      return input.path === row.path ? { sha256: row.sha256, sizeBytes: row.sizeBytes } : null;
    },
  };
  let now = NOW;
  const service = new ArtifactSandbox({
    reads: reads as never,
    readBlob: async () => options.bytes ?? PAGE,
    origin: options.origin === undefined ? SANDBOX : options.origin,
    nonces: options.nonces ?? new MemoryTicketNonces(() => now.getTime()),
    secret: async () => SECRET,
    now: () => now,
  });
  return { service, later: (ms: number) => (now = new Date(NOW.getTime() + ms)) };
}

const linkInput = { workspaceId: "w1", userId: "u1", artifactId: A, embedderOrigin: APP };

describe("a web page's link", () => {
  test("is on the artifact's own origin, pinned to the current version", async () => {
    const { service } = sandbox({ number: 4 });
    const link = await service.link(linkInput);
    expect(link.url.startsWith(`${A_ORIGIN}/_coforge/open?ticket=`)).toBe(true);
    expect(link.version).toBe(4);
    const ticket = readSandboxTicket(new URL(link.url).searchParams.get("ticket")!, SECRET);
    expect(ticket).toMatchObject({ w: "w1", a: A, v: 4, u: "u1", o: APP, s: A_ORIGIN });
  });

  test("is refused with no sandbox origin, or an embedder on the sandbox's host or under it", async () => {
    await expect(sandbox({}, { origin: null }).service.link(linkInput)).rejects.toMatchObject({
      errorId: "artifact-sandbox-off",
    });
    for (const embedderOrigin of ["https://sandbox.example", "https://app.sandbox.example"])
      await expect(sandbox().service.link({ ...linkInput, embedderOrigin })).rejects.toMatchObject({
        errorId: "artifact-sandbox-off",
      });
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

  test("the bare host and any other name under it serve nothing but a refusal", async () => {
    const { service, url } = await opened();
    const ticket = new URL(url).search;
    for (const base of [
      SANDBOX,
      "https://www.sandbox.example",
      `https://a-${A}.extra.sandbox.example`,
      "https://a-nope.sandbox.example",
    ])
      for (const path of [
        "/",
        `/_coforge/open${ticket}`,
        "/_coforge/runtime.js",
        "/_f/x.y/index.html",
      ]) {
        const response = await service.serve(new Request(`${base}${path}`, { headers: FRAME }));
        expect(response.status, base + path).toBe(404);
        expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      }
  });

  test("a ticket opens one page: a redirect to the entry under a file token for this origin", async () => {
    const { service, url, later } = await opened({ number: 4 });
    later(30_000);
    const response = await openLink(service, url);
    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const token = /^\/_f\/([^/]+)\/index\.html$/.exec(response.headers.get("location")!)?.[1];
    expect(token).toBeDefined();
    expect(readSandboxFileToken(token!, SECRET)).toMatchObject({
      w: "w1",
      a: A,
      v: 4,
      u: "u1",
      o: APP,
      s: A_ORIGIN,
      exp: NOW.getTime() / 1000 + 30 + SANDBOX_FILE_TTL_SECONDS,
    });
  });

  test("a ticket is single use: the second is a small page posting its status to the framing app", async () => {
    const { service, url } = await opened();
    expect((await openLink(service, url)).status).toBe(302);
    const used = await openLink(service, url);
    expect(used.status).toBe(401);
    const body = await used.text();
    expect(body).toContain("This link was used");
    expect(body).toContain('"state":"blocked"');
    expect(body).toContain('"reason":"used"');
    expect(body).toContain(`,${JSON.stringify(APP)});`);
    expect(body).not.toContain('"*"');
    const csp = used.headers.get("content-security-policy")!;
    expect(csp).toContain(`frame-ancestors ${APP}`);
    expect(csp).toContain("sandbox allow-scripts allow-same-origin");
    expect(csp).toContain("webrtc 'block'");
    expect(csp).toContain("script-src 'nonce-");
  });

  test("a ticket is single use however many open it at once", async () => {
    const { service, url } = await opened();
    const answers = await Promise.all(Array.from({ length: 5 }, () => openLink(service, url)));
    expect(answers.filter((response) => response.status === 302)).toHaveLength(1);
    expect(answers.filter((response) => response.status === 401)).toHaveLength(4);
  });

  test("an expired ticket says so, to the framing app", async () => {
    const { service, url, later } = await opened();
    later(SANDBOX_TICKET_TTL_SECONDS * 1000);
    const response = await openLink(service, url);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('"reason":"expired"');
  });

  test("a ticket opens only on the origin it names", async () => {
    const { service, url } = await opened();
    const ticket = new URL(url).search;
    for (const origin of [B_ORIGIN, "https://a-nope.sandbox.example", SANDBOX]) {
      const response = await service.serve(
        new Request(`${origin}/_coforge/open${ticket}`, { headers: FRAME }),
      );
      expect(response.status, origin).toBe(404);
    }
    expect((await openLink(service, url)).status).toBe(302);
  });

  test("a ticket is refused when its nonce cannot be spent: a single-use link never fails open", async () => {
    const { service, url } = await opened(
      {},
      { nonces: { claim: async () => Promise.reject(new Error("redis down")) } },
    );
    await expect(openLink(service, url)).rejects.toThrow("redis down");
  });

  test("a value signed for another purpose, or none, opens nothing", async () => {
    const { service } = await opened();
    const forged = signValue(
      "session",
      { w: "w1", a: A, v: 1, u: "u1", o: APP, s: A_ORIGIN, n: "n", iat: 1, exp: 9e9 },
      SECRET,
    );
    for (const query of ["", "?ticket=", "?ticket=x.y", `?ticket=${forged}`])
      expect(
        (await service.serve(new Request(`${A_ORIGIN}/_coforge/open${query}`, { headers: FRAME })))
          .status,
      ).toBe(404);
  });

  test("the page, with its scripts and own files allowed and everything else closed", async () => {
    const { service, url } = await opened();
    const { filesUrl, response } = await openPage(service, url);
    expect(response.status).toBe(200);
    const served = await response.text();
    expect(served).toStartWith(
      `<!doctype html><script src="/_coforge/runtime.js" data-host="${APP}"></script>`,
    );
    expect(served).toEndWith(new TextDecoder().decode(PAGE).slice("<!doctype html>".length));
    expect(response.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(served).byteLength),
    );
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(filesUrl.startsWith(`${A_ORIGIN}/_f/`)).toBe(true);
    const csp = (response.headers.get("content-security-policy") ?? "").split("; ");
    const starts = [
      "sandbox allow-scripts allow-same-origin",
      "default-src 'none'",
      `script-src 'unsafe-inline' 'unsafe-eval' blob: ${A_ORIGIN}/_coforge/runtime.js ${filesUrl}`,
      `style-src 'unsafe-inline' ${filesUrl}`,
      `img-src data: blob: ${filesUrl}`,
      `font-src data: ${filesUrl}`,
      `media-src data: blob: ${filesUrl}`,
      `connect-src ${filesUrl}`,
      `worker-src blob: ${filesUrl}`,
      "child-src blob:",
      "frame-src 'none'",
      "object-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "webrtc 'block'",
      `frame-ancestors ${APP}`,
    ];
    expect(csp).toHaveLength(starts.length);
    starts.forEach((start, index) => expect(csp[index]).toStartWith(start));
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const policy = response.headers.get("permissions-policy")!;
    for (const feature of [
      "camera",
      "microphone",
      "geolocation",
      "clipboard-read",
      "clipboard-write",
      "usb",
      "payment",
      "fullscreen",
    ])
      expect(policy).toContain(`${feature}=()`);
  });

  test("the page is a document only for a frame or a tab", async () => {
    const { service, url } = await opened();
    const { filesUrl } = await openPage(service, url);
    const asked = (dest: string | null) =>
      service.serve(
        new Request(`${filesUrl}index.html`, {
          headers: dest ? { "Sec-Fetch-Dest": dest } : ({} as Record<string, string>),
        }),
      );
    expect((await asked("iframe")).status).toBe(200);
    expect((await asked("document")).status).toBe(200);
    expect((await asked(null)).status).toBe(404);
    expect((await asked("embed")).status).toBe(404);
    expect((await asked("object")).status).toBe(404);
  });

  test("a page's file under a token is served only on that token's artifact origin", async () => {
    const { service, url } = await opened();
    const { filesUrl } = await openPage(service, url);
    const path = filesUrl.slice(A_ORIGIN.length);
    for (const origin of [B_ORIGIN, SANDBOX, "https://www.sandbox.example"]) {
      const response = await service.serve(
        new Request(`${origin}${path}index.html`, { headers: FRAME }),
      );
      expect(response.status, origin).toBe(404);
    }
  });

  test("a file token expires after ten minutes", async () => {
    const { service, url, later } = await opened();
    const { filesUrl } = await openPage(service, url);
    later(SANDBOX_FILE_TTL_SECONDS * 1000 - 1);
    expect(
      (await service.serve(new Request(`${filesUrl}index.html`, { headers: FRAME }))).status,
    ).toBe(200);
    later(SANDBOX_FILE_TTL_SECONDS * 1000);
    const late = await service.serve(new Request(`${filesUrl}index.html`, { headers: FRAME }));
    expect(late.status).toBe(403);
    expect(await late.text()).toContain("expired");
  });

  test("a page file is also served to a fetch of the page, with no page headers", async () => {
    const { service, url } = await opened();
    const { filesUrl } = await openPage(service, url);
    const fetched = await service.serve(
      new Request(`${filesUrl}index.html`, { headers: subresource("empty") }),
    );
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe(new TextDecoder().decode(PAGE));
    expect(fetched.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  });

  test("HEAD has the headers and no body; other methods are refused", async () => {
    const { service, url } = await opened();
    const { filesUrl } = await openPage(service, url);
    const head = await service.serve(
      new Request(`${filesUrl}index.html`, { method: "HEAD", headers: FRAME }),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await service.serve(new Request(url, { method: "POST" }))).status).toBe(405);
  });

  test("anything but a valid address is a refusal that runs nothing", async () => {
    const { service } = await opened();
    for (const path of [
      "/",
      "/a/",
      "/api/me",
      "/w/acme",
      "/_f/",
      "/_f/x.y",
      "/_f/x.y/",
      "/_coforge/",
      "/_coforge/other",
    ]) {
      const response = await service.serve(new Request(`${A_ORIGIN}${path}`, { headers: FRAME }));
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    }
  });

  test("the runtime is served, closed", async () => {
    const { service } = await opened();
    const response = await service.serve(
      new Request(`${A_ORIGIN}/_coforge/runtime.js`, { headers: subresource("script") }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    const source = await response.text();
    expect(source).toContain("ui/initialize");
    expect(source).toContain("coforge");
  });

  test("a reader who lost access since the ticket was made gets nothing", async () => {
    let readable = true;
    const { service, url } = await opened({}, { readable: () => readable });
    readable = false;
    expect((await openLink(service, url)).status).toBe(404);
  });

  test("a reader who lost access after opening gets no page document", async () => {
    let readable = true;
    const { service, url } = await opened({}, { readable: () => readable });
    const { filesUrl } = await openPage(service, url);
    readable = false;
    expect(
      (await service.serve(new Request(`${filesUrl}index.html`, { headers: FRAME }))).status,
    ).toBe(404);
  });

  test("bytes over the limit are not served, whatever the row says", async () => {
    const { service, url } = await opened({}, { bytes: new Uint8Array(ARTIFACT_HTML_LIMIT + 1) });
    const redirect = await openLink(service, url);
    const location = new URL(redirect.headers.get("location")!, url);
    expect((await service.serve(new Request(location, { headers: FRAME }))).status).toBe(404);
  });
});

describe("the page runtime's place in a page", () => {
  const text = (page: string, host: string | null = APP) =>
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      withPageRuntime(new TextEncoder().encode(page), host),
    );

  test("goes after a leading doctype, so the page keeps its standards mode", () => {
    const out = text("﻿  <!DOCTYPE html>\n<html><p>x</p></html>");
    expect(out).toStartWith(
      `﻿  <!DOCTYPE html><script src="/_coforge/runtime.js" data-host="${APP}">`,
    );
    expect(out).toEndWith("</script>\n<html><p>x</p></html>");
  });

  test("goes first when there is no doctype, before any script of the page's", () => {
    const out = text("<script>new RTCPeerConnection()</script>");
    expect(out.indexOf("runtime.js")).toBeLessThan(out.indexOf("new RTCPeerConnection"));
  });

  test("names no host for a page that has no app around it", () => {
    expect(text("<p>x</p>", null)).toStartWith('<script src="/_coforge/runtime.js"></script>');
  });
});
