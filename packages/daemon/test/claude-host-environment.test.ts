import { afterEach, beforeEach, expect, test } from "bun:test";
import { claudeRuntimeHost } from "#src/code-agent/claude-code/host";
import { claudeCliEnvironment } from "#src/code-agent/claude-code/process";
import { ClaudeRuntimeAuthAdapter } from "@lrm/coforge-anvil/claude-code";
import { FakeAuthProcess } from "../../anvil/test/fixtures/claude-auth";
import { claudeAuthHost } from "#src/code-agent/claude-code/auth-host";

const keys = [
  "CLAUDECODE",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "USER",
  "TZ",
  "NO_COLOR",
  "BROWSER",
  "SystemRoot",
  "ANVIL_CLAUDE_AMBIENT",
  "ANVIL_CLAUDE_CONFLICT",
  "GIT_CONFIG_KEY_5",
  "GIT_CONFIG_VALUE_5",
] as const;
let previous: Record<string, string | undefined>;

beforeEach(() => {
  previous = Object.fromEntries(keys.map((key) => [key, Bun.env[key]]));
  Object.assign(Bun.env, {
    CLAUDECODE: "ambient-marker",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1M",
    USER: "fixture-user",
    TZ: "Asia/Shanghai",
    NO_COLOR: "0",
    BROWSER: "fixture-browser",
    SystemRoot: "C:\\fixture-windows",
    ANVIL_CLAUDE_AMBIENT: "ambient-only",
    ANVIL_CLAUDE_CONFLICT: "ambient",
    GIT_CONFIG_KEY_5: "fixture.previous",
    GIT_CONFIG_VALUE_5: "fixture-previous-value",
  });
});

function selected(environment: Record<string, string>) {
  return Object.fromEntries(
    [...keys, "FORCE_COLOR", "GIT_CONFIG_COUNT"].map((key) => [key, environment[key]]),
  );
}

afterEach(() => {
  for (const key of keys) {
    const value = previous[key];
    if (value === undefined) delete Bun.env[key];
    else Bun.env[key] = value;
  }
});

test("Claude session preserves declared precedence, compact-window parsing and hook injection", () => {
  const result = claudeRuntimeHost.buildSessionEnvironment({
    agentWorkspaceDirectory: "/fixture",
    instructions: "fixture instructions",
    environment: {
      ANVIL_CLAUDE_CONFLICT: "declared",
      CLAUDECODE: "declared-marker",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300k",
      GIT_CONFIG_COUNT: "0",
    },
    runtime: {
      provider: "claude-code",
      model: "",
      reasoning: "",
      envVars: {
        ANVIL_CLAUDE_CONFLICT: "runtime",
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "400k",
      },
    },
    gitHooks: { kind: "hooks-path", hooksDir: "/fixture/hooks" },
  });
  expect(selected(result.environment)).toMatchObject({
    ANVIL_CLAUDE_AMBIENT: "ambient-only",
    ANVIL_CLAUDE_CONFLICT: "declared",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300k",
    USER: "fixture-user",
    TZ: "Asia/Shanghai",
    NO_COLOR: "0",
    FORCE_COLOR: "0",
    GIT_CONFIG_KEY_5: "core.hooksPath",
    GIT_CONFIG_VALUE_5: "/fixture/hooks",
    GIT_CONFIG_COUNT: "6",
  });
  expect(result.environment.CLAUDECODE).toBeUndefined();
  expect(result.autoCompactWindow).toBe(300_000);
});

test("Claude usage keeps live USER and ambient fields, removes the marker and forces UTC", () => {
  const environment = claudeCliEnvironment({
    ANVIL_CLAUDE_CONFLICT: "declared",
    CLAUDECODE: "declared-marker",
    TZ: "declared-zone",
  });
  expect(selected(environment)).toMatchObject({
    ANVIL_CLAUDE_AMBIENT: "ambient-only",
    ANVIL_CLAUDE_CONFLICT: "declared",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1M",
    USER: "fixture-user",
    NO_COLOR: "0",
    FORCE_COLOR: "0",
    TZ: "UTC",
  });
  expect(environment.CLAUDECODE).toBeUndefined();
  delete Bun.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  expect(claudeCliEnvironment().CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
});

test("Claude auth reads ambient environment per operation and keeps its distinct browser policy", async () => {
  const seen: Record<string, string | undefined>[] = [];
  const adapter = new ClaudeRuntimeAuthAdapter({
    host: claudeAuthHost,
    command: "/fixture/claude",
    create: (_command, options) => {
      seen.push(Object.fromEntries(keys.map((key) => [key, options.env[key]])));
      const child = new FakeAuthProcess();
      queueMicrotask(() => {
        child.say('{"loggedIn":false}');
        child.finish(0);
      });
      return child;
    },
  });
  Bun.env.ANVIL_CLAUDE_CONFLICT = "after-construction";
  expect(await adapter.readStatus({ workingDirectory: "/fixture" })).toMatchObject({
    state: "logged_out",
  });
  expect(seen[0]).toMatchObject({
    ANVIL_CLAUDE_AMBIENT: "ambient-only",
    ANVIL_CLAUDE_CONFLICT: "after-construction",
    CLAUDECODE: "ambient-marker",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1M",
    USER: "fixture-user",
    TZ: "Asia/Shanghai",
    NO_COLOR: "1",
    BROWSER: process.platform === "win32" ? "C:\\fixture-windows\\System32\\hostname.exe" : "true",
  });
  delete Bun.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  Bun.env.ANVIL_CLAUDE_CONFLICT = "next-operation";
  await adapter.readStatus({ workingDirectory: "/fixture" });
  expect(seen[1]?.ANVIL_CLAUDE_CONFLICT).toBe("next-operation");
  expect(seen[1]?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
});
