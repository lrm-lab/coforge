import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { OpenCodeProvider, isOpenCodeVersionUnsupported } from "@lrm/coforge-anvil/opencode";
import { isVersionBelow } from "@lrm/coforge-anvil";

import { fixturePerTurnHost, fixtureVersionReader } from "./fixtures/runtime-host";

test("a single leading v is part of the dotted version", () => {
  expect(isVersionBelow("v1.9.0", "2.0.0")).toBe(true);
  expect(isVersionBelow("V1.9.0", "2.0.0")).toBe(true);
  expect(isVersionBelow("v2.0.0", "2.0.0")).toBe(false);
  expect(isVersionBelow("v2.1.0", "2.0.0")).toBe(false);
  expect(isVersionBelow("1.9.0", "2.0.0")).toBe(true);
});

test("a version that is still not dotted numbers is never below the minimum", () => {
  expect(isVersionBelow("vv1.0.0", "2.0.0")).toBe(false);
  expect(isVersionBelow("v1.9.0-beta", "2.0.0")).toBe(false);
  expect(isVersionBelow("nightly", "2.0.0")).toBe(false);
});

test("OpenCode's minimum applies to the v prefix its CLI prints", () => {
  expect(isOpenCodeVersionUnsupported("v1.18.31")).toBe(true);
  expect(isOpenCodeVersionUnsupported("v2.0.0")).toBe(false);
  expect(isOpenCodeVersionUnsupported("v2.1.0")).toBe(false);
  expect(isOpenCodeVersionUnsupported("nightly")).toBe(false);
});

test("an OpenCode launch is refused when --version prints opencode v1", async () => {
  const provider = new OpenCodeProvider({
    host: fixturePerTurnHost,
    versionReader: fixtureVersionReader,
    command: ["/bin/sh", "-c", 'printf "opencode v1.18.31\\n"'],
  });

  await expect(
    provider.createAgentSession({
      agentWorkspaceDirectory: tmpdir(),
      instructions: "Standing OpenCode instructions.",
    }),
  ).rejects.toMatchObject({
    code: "runtime_version_too_old",
    message:
      "OpenCode v1.18.31 is unsupported; requires OpenCode >= 2.0.0. Upgrade opencode before starting this runtime.",
  });
});
