import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexProvider } from "@lrm/coforge-anvil/codex";
import { fixtureCodexHost } from "./fixtures/codex-host";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-codex-env-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const CODEX_HOME = "/home/fixture/.codex";

function provider(environment?: Record<string, string>): CodexProvider {
  return new CodexProvider({
    host: environment
      ? { ...fixtureCodexHost, buildSessionEnvironment: () => environment }
      : fixtureCodexHost,
    command: [
      process.execPath,
      new URL("./fixtures/codex-app-server-scenarios.ts", import.meta.url).pathname,
      `log=${join(directory, "requests.jsonl")}`,
    ],
  });
}

for (const method of ["thread/start", "thread/resume"] as const) {
  test(`a ${method} shell restores every host Git config key after secret exclusions`, async () => {
    const environment: Record<string, string> = {
      HOME: "/home/fixture",
      CODEX_HOME,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "!fixture-credential-helper",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: "/fixture/hooks",
      GIT_CONFIG_KEY_NOT_AN_INDEX: "excluded",
      SOME_API_KEY: "excluded",
      SOME_SECRET: "excluded",
      SOME_TOKEN: "excluded",
    };
    const session = await provider(environment).createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: "Test Agent instructions.",
      sessionId: method === "thread/resume" ? "thread-1" : undefined,
    });
    try {
      const policy = (await threadConfig(method))?.shell_environment_policy as {
        inherit: string;
        ignore_default_excludes: boolean;
        set: Record<string, string>;
      };
      expect(policy).toEqual({
        inherit: "all",
        ignore_default_excludes: false,
        set: Object.fromEntries(
          Array.from({ length: Number(environment.GIT_CONFIG_COUNT) }, (_, index) => {
            const key = `GIT_CONFIG_KEY_${index}`;
            const value = environment[key];
            if (value === undefined) throw new Error(`Missing fixture key ${key}`);
            return [key, value];
          }),
        ),
      });
    } finally {
      await session.dispose();
    }
  });
}

async function threadConfig(method: "thread/start" | "thread/resume") {
  const log = await readFile(join(directory, "requests.jsonl"), "utf8");
  const request = log
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    .find((entry) => entry.method === method);
  return request?.params?.config as Record<string, unknown> | undefined;
}

// A shell Codex launches inherits what the session was launched with; the policy only keeps
// Codex's own KEY/SECRET/TOKEN exclusions. An include list here once dropped XDG_RUNTIME_DIR and
// DBUS_SESSION_BUS_ADDRESS, which left `systemctl --user` with no user bus on Linux.
for (const method of ["thread/start", "thread/resume"] as const) {
  test(`a ${method} shell inherits the environment, bar the default secret exclusions`, async () => {
    // The host environment is pinned: an Agent running this test has its own Git config keys.
    const session = await provider({ HOME: "/home/fixture", CODEX_HOME }).createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: "Test Agent instructions.",
      sessionId: method === "thread/resume" ? "thread-1" : undefined,
    });
    try {
      expect((await threadConfig(method))?.shell_environment_policy).toEqual({
        inherit: "all",
        ignore_default_excludes: false,
        set: {},
      });
    } finally {
      await session.dispose();
    }
  });
}
