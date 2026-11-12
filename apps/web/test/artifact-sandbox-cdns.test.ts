import { describe, expect, test } from "bun:test";
import {
  SANDBOX_PUBLIC_CDNS,
  withPublicCdns,
} from "#src/server/artifacts/artifact-sandbox-cdns.server";
import { sandboxPageHeaders } from "#src/server/artifacts/artifact-sandbox-response.server";

/**
 * The public hosts a web page may load scripts, styles and fonts from. They are the only hosts a
 * page's CSP names besides its own file prefix and `frame-ancestors`; the page still reaches
 * nothing over the network (`connect-src 'none'`). What a real browser does with the list is
 * `artifact-sandbox-browser.e2e.ts`, which never reaches the real hosts.
 */

const SANDBOX = "https://sandbox.example";
const APP = "https://app.example";
const PREFIX = `${SANDBOX}/a/t.s/page/`;

function directives() {
  const csp = sandboxPageHeaders({
    sandboxOrigin: SANDBOX,
    appOrigin: APP,
    filePrefix: PREFIX,
  }).get("content-security-policy")!;
  return Object.fromEntries(
    csp.split("; ").map((directive) => {
      const [name, ...sources] = directive.split(" ");
      return [name!, sources];
    }),
  );
}

describe("the public hosts a page may load from", () => {
  test("are exactly the listed CDNs", () => {
    expect([...SANDBOX_PUBLIC_CDNS]).toEqual([
      "https://cdnjs.cloudflare.com",
      "https://cdn.jsdelivr.net",
      "https://unpkg.com",
      "https://esm.sh",
      "https://cdn.tailwindcss.com",
      "https://code.jquery.com",
      "https://cdn.plot.ly",
    ]);
  });

  test("script, style, font and image sources name them; styles and fonts name Google Fonts", () => {
    const csp = directives();
    for (const name of ["script-src", "style-src", "font-src", "img-src"])
      for (const host of SANDBOX_PUBLIC_CDNS) expect(csp[name], name).toContain(host);
    expect(csp["style-src"]).toContain("https://fonts.googleapis.com");
    expect(csp["font-src"]).toContain("https://fonts.gstatic.com");
    expect(csp["script-src"]).not.toContain("https://fonts.googleapis.com");
    expect(csp["script-src"]).not.toContain("https://fonts.gstatic.com");
    expect(csp["img-src"]).not.toContain("https://fonts.gstatic.com");
    // Media comes from the page's own files only.
    expect(csp["media-src"]).toEqual(["data:", "blob:", PREFIX]);
  });

  test("leave every way out closed", () => {
    const csp = directives();
    expect(csp["connect-src"]).toEqual(["'none'"]);
    expect(csp["form-action"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'none'"]);
    expect(csp["default-src"]).toEqual(["'none'"]);
    expect(csp["frame-src"]).toBeUndefined();
    expect(csp["sandbox"]).toEqual(["allow-scripts"]);
    expect(csp["webrtc"]).toEqual(["'block'"]);
    expect(csp["frame-ancestors"]).toEqual([SANDBOX, APP]);
    // No wildcard anywhere, and every https host named is on the list.
    const named = Object.entries(csp).flatMap(([name, sources]) =>
      name === "frame-ancestors" ? [] : sources.filter((source) => /^https?:/.test(source)),
    );
    const allowed = new Set<string>([
      ...SANDBOX_PUBLIC_CDNS,
      "https://fonts.googleapis.com",
      "https://fonts.gstatic.com",
      PREFIX,
    ]);
    for (const source of named) expect(allowed.has(source), source).toBe(true);
    expect(JSON.stringify(csp)).not.toContain("*");
  });

  test("are added to a directive list without disturbing the others", () => {
    expect(withPublicCdns(["default-src 'none'", "connect-src 'none'"])).toEqual([
      "default-src 'none'",
      "connect-src 'none'",
    ]);
    expect(withPublicCdns(["script-src 'unsafe-inline'"])[0]).toStartWith(
      "script-src 'unsafe-inline' https://cdnjs.cloudflare.com",
    );
  });
});
