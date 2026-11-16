import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  ArtifactSandboxConfigError,
  artifactPageOrigin,
  isSandboxRequest,
  readArtifactSandboxConfig,
  sandboxTarget,
} from "#src/server/artifacts/artifact-sandbox-config.server";

const SANDBOX = "https://sandbox.example";
const APP = "https://app.example";
const A = "11111111-1111-4111-8111-111111111111";
const A_ORIGIN = `https://a-${A}.sandbox.example`;

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

  test("allows plain http only on localhost: an IP literal cannot carry a label", () => {
    expect(
      readArtifactSandboxConfig({ COFORGE_ARTIFACT_SANDBOX_ORIGIN: "http://localhost:5199" }),
    ).toEqual({ origin: "http://localhost:5199" });
    for (const value of ["http://sandbox.example", "http://127.0.0.1:5199", "http://[::1]:5199"])
      expect(() => readArtifactSandboxConfig({ COFORGE_ARTIFACT_SANDBOX_ORIGIN: value })).toThrow(
        ArtifactSandboxConfigError,
      );
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
      ["https://app.example:8443", { COFORGE_OIDC_ISSUER: `${APP}/oidc` }, "own host"],
      [APP, { COFORGE_GITHUB_CALLBACK_URL: `${APP}/auth/github/callback` }, "own host"],
    ] as const;
    for (const [origin, env, message] of refused)
      expect(() =>
        readArtifactSandboxConfig({ COFORGE_ARTIFACT_SANDBOX_ORIGIN: origin, ...env }, () => {}),
      ).toThrow(message);
  });

  test("refuses a parent of the application: every name under the sandbox host is the sandbox's", () => {
    expect(() =>
      readArtifactSandboxConfig(
        { COFORGE_ARTIFACT_SANDBOX_ORIGIN: "https://example", COFORGE_OIDC_ISSUER: `${APP}/oidc` },
        () => {},
      ),
    ).toThrow("nor a parent");
  });

  test("allows a subdomain of the application (task #544): cookies stay host-only", () => {
    expect(() =>
      readArtifactSandboxConfig(
        {
          COFORGE_ARTIFACT_SANDBOX_ORIGIN: "https://usercontent.app.example",
          COFORGE_OIDC_ISSUER: `${APP}/oidc`,
        },
        () => {},
      ),
    ).not.toThrow();
  });

  test("no cookie the application sets carries a Domain attribute", async () => {
    const web = resolve(import.meta.dir, "..");
    const violations: string[] = [];
    for await (const path of new Bun.Glob("src/**/*.{ts,tsx}").scan(web)) {
      const source = await Bun.file(resolve(web, path)).text();
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
});

describe("a request's host name", () => {
  test("is the sandbox's when it is the sandbox host or any name under it", () => {
    expect(isSandboxRequest(new Request("http://sandbox.example/a/x.y"), SANDBOX)).toBe(true);
    expect(isSandboxRequest(new Request(`${A_ORIGIN}/x`), SANDBOX)).toBe(true);
    expect(isSandboxRequest(new Request("http://anything.sandbox.example/"), SANDBOX)).toBe(true);
    expect(isSandboxRequest(new Request(`${APP}/a/x.y`), SANDBOX)).toBe(false);
    expect(isSandboxRequest(new Request("http://notsandbox.example/"), SANDBOX)).toBe(false);
    expect(isSandboxRequest(new Request("http://sandbox.example.evil.test/"), SANDBOX)).toBe(false);
    expect(isSandboxRequest(new Request("http://sandbox.example/"), null)).toBe(false);
    expect(isSandboxRequest(new Request("http://sandbox.example./a/x.y"), SANDBOX)).toBe(true);
    expect(isSandboxRequest(new Request("http://sandbox.example:443/"), SANDBOX)).toBe(true);
    expect(isSandboxRequest(new Request("http://SANDBOX.example/"), SANDBOX)).toBe(true);
  });

  test("is the bare host, one artifact's origin, or any other name", () => {
    const target = (url: string) => sandboxTarget(new Request(url), SANDBOX);
    expect(target("https://sandbox.example/")).toEqual({ kind: "bare" });
    expect(target(`${A_ORIGIN}/`)).toEqual({ kind: "artifact", artifactId: A });
    expect(target(`https://a-${A.toUpperCase()}.sandbox.example./`)).toEqual({
      kind: "artifact",
      artifactId: A,
    });
    for (const host of [
      "www.sandbox.example",
      "a-nope.sandbox.example",
      `a-${A}.extra.sandbox.example`,
      `x.a-${A}.sandbox.example`,
      `${A}.sandbox.example`,
      `a-${A}x.sandbox.example`,
    ])
      expect(target(`https://${host}/`), host).toEqual({ kind: "other" });
  });

  test("an artifact's origin keeps the sandbox's scheme and port", () => {
    expect(artifactPageOrigin(SANDBOX, A.toUpperCase())).toBe(A_ORIGIN);
    expect(artifactPageOrigin("http://localhost:5199", A)).toBe(`http://a-${A}.localhost:5199`);
  });
});
