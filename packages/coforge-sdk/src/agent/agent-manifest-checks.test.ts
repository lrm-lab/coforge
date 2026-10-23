import { expect, test } from "bun:test";
import { checkBaseUrlOrigin, httpsUrlProblem } from "./agent-manifest-checks";
import type { AgentManifest } from "./agent-manifest-types";

test("httpsUrlProblem accepts only plain https URLs of bounded length", () => {
  expect(httpsUrlProblem("https://notes.test/m.json?x=1")).toBeUndefined();
  expect(httpsUrlProblem("http://notes.test/")).toContain("https");
  expect(httpsUrlProblem("https://a:b@notes.test/")).toContain("credentials");
  expect(httpsUrlProblem("https://notes.test/#frag")).toContain("fragment");
  expect(httpsUrlProblem("nope")).toContain("absolute");
  expect(httpsUrlProblem("")).toContain("2048");
  expect(httpsUrlProblem(`https://notes.test/${"a".repeat(2048)}`)).toContain("2048");
  expect(httpsUrlProblem(42)).toContain("2048");
});

test("base_url must share an origin with the homepage or the manifest URL", () => {
  const manifest = {
    execution: { mode: "http_api", base_url: "https://notes.test/api" },
  } as AgentManifest;
  const check = (homepage: string | null, url: string) =>
    checkBaseUrlOrigin(manifest, { homepageUrl: homepage, manifestUrl: url });
  expect(check("https://notes.test/", "https://cdn.test/m.json")).toBeUndefined();
  expect(check(null, "https://notes.test/m.json")).toBeUndefined();
  expect(check("https://other.test/", "https://cdn.test/m.json")).toMatchObject({
    path: "/execution/base_url",
  });
});
