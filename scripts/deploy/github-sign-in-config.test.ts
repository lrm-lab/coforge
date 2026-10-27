import { describe, expect, test } from "bun:test";

/** The Web service's block of a compose file: from `web:` to the next service. */
async function webBlock(environment: "staging" | "production"): Promise<string> {
  const compose = await Bun.file(
    new URL(`../../infra/${environment}/docker-compose.yml`, import.meta.url),
  ).text();
  const webStart = compose.indexOf("\n  web:\n");
  const centrifugoStart = compose.indexOf("\n  centrifugo:\n");
  expect(webStart).toBeGreaterThanOrEqual(0);
  expect(centrifugoStart).toBeGreaterThan(webStart);
  return compose.slice(webStart, centrifugoStart);
}

describe("GitHub sign-in runtime configuration", () => {
  // Both environments sign in through the same GitHub OAuth app (`CoForge` in lrm-lab) and an
  // Authing "GitHub Mobile" connection named `github-mobile` in their own user pool. Neither value is
  // secret: the client secret lives only in Authing.
  for (const environment of ["staging", "production"] as const) {
    test(`${environment} web names the GitHub OAuth app and the Authing connection`, async () => {
      const block = await webBlock(environment);
      expect(block).toContain("AUTHING_GITHUB_CONNECTION: github-mobile");
      expect(block).toContain("COFORGE_GITHUB_SIGN_IN_CLIENT_ID: Ov23lig3ZSmcMqA97yAN");
    });
  }
});
