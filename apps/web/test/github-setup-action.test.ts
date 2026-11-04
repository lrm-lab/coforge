import { expect, test } from "bun:test";

import { githubSetupAction } from "#src/features/onboarding/github-setup-action";

test("each GitHub status maps to one flow, none for unconfigured or connected", () => {
  expect(githubSetupAction("disconnected")).toBe("connect");
  expect(githubSetupAction("pending_installation")).toBe("install");
  expect(githubSetupAction("reauthorize")).toBe("reauthorize");
  expect(githubSetupAction("connected")).toBeNull();
  expect(githubSetupAction("unconfigured")).toBeNull();
});
