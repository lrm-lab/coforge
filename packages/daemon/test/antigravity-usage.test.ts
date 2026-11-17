import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { AntigravityAcpProvider } from "@lrm/coforge-anvil/antigravity";
import { antigravityAcpRuntimeHost } from "#src/code-agent/antigravity/acp-host";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";
import { ANTIGRAVITY_USAGE_BUDGET_MS as USAGE_BUDGET_MS } from "./catalog-discovery-budget";
import { SIGNED_IN, withAntigravityHome } from "./fixtures/antigravity-home";
const FIXTURE = anvilRuntimeFixtures.antigravityUsage;
test(
  "the provider reads usage through its own agy command",
  async () => {
    const snapshot = await withAntigravityHome(SIGNED_IN, () =>
      new AntigravityAcpProvider({
        host: antigravityAcpRuntimeHost,
        command: [process.execPath, FIXTURE],
      }).readUsage({ workingDirectory: tmpdir() }),
    );
    expect(snapshot?.primary?.id).toBe("antigravity-gemini-5h");
  },
  USAGE_BUDGET_MS,
);

test("a cached account id or OAuth file is a sign-in; none, or a blank id, is not", async () => {
  const signedIn = (files: Record<string, string>) =>
    withAntigravityHome(files, () => antigravityAcpRuntimeHost.readUsageAuthStatus!());
  expect(await signedIn({})).toBe(false);
  expect(await signedIn({ google_account_id: "  \n" })).toBe(false);
  expect(await signedIn(SIGNED_IN)).toBe(true);
  expect(await signedIn({ "oauth_creds.json": "{}" })).toBe(true);
});
