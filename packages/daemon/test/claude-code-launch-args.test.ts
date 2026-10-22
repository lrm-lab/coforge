import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLAUDE_DISALLOWED_TOOLS,
  claudeLaunchCommand,
} from "#src/code-agent/claude-code/launch-args";
import { claudeCliEnvironment } from "#src/code-agent/claude-code/process";
import { ClaudeCodeProvider } from "#src/code-agent/claude-code/provider";
import { discoverExternalCodeAgents } from "#src/code-agent/runtime-probe";
import { agentEnvironment } from "#src/code-agent/environment";

const BASE = ["claude", "-p"];
const DISALLOWED = "EnterPlanMode,ExitPlanMode,ScheduleWakeup,CronCreate,CronList,CronDelete";
const COMMON = [
  "--dangerously-skip-permissions",
  "--permission-mode",
  "bypassPermissions",
  "--disallowed-tools",
  DISALLOWED,
];

let previousMarker: string | undefined;
beforeEach(() => {
  previousMarker = process.env.CLAUDECODE;
  process.env.CLAUDECODE = "1";
});
afterEach(() => {
  if (previousMarker === undefined) delete process.env.CLAUDECODE;
  else process.env.CLAUDECODE = previousMarker;
});

test("the disallowed tools are one comma-joined argument in a fixed order", () => {
  expect(CLAUDE_DISALLOWED_TOOLS.join(",")).toBe(DISALLOWED);
});

test("a fresh launch passes --session-id and the disallowed tools exactly once", () => {
  const argv = claudeLaunchCommand(BASE, { promptPath: "/p", createSessionId: "new-id" });
  expect(argv).toEqual([
    ...BASE,
    ...COMMON,
    "--session-id",
    "new-id",
    "--append-system-prompt-file",
    "/p",
  ]);
  expect(argv.filter((arg) => arg === "--disallowed-tools")).toHaveLength(1);
});

test("a resumed launch passes --resume and the disallowed tools exactly once", () => {
  const argv = claudeLaunchCommand(BASE, { promptPath: "/p", resumeSessionId: "old-id" });
  expect(argv).toEqual([
    ...BASE,
    ...COMMON,
    "--resume",
    "old-id",
    "--append-system-prompt-file",
    "/p",
  ]);
  expect(argv.filter((arg) => arg === DISALLOWED)).toHaveLength(1);
});

test("model, effort and Fast mode are appended after the prompt file", () => {
  const argv = claudeLaunchCommand(BASE, {
    promptPath: "/p",
    createSessionId: "id",
    runtime: {
      provider: "claude-code",
      model: "claude-opus-5-5",
      modelProvider: "",
      reasoning: "high",
      fastMode: true,
    },
  });
  expect(argv).toEqual([
    ...BASE,
    ...COMMON,
    "--session-id",
    "id",
    "--append-system-prompt-file",
    "/p",
    "--model",
    "claude-opus-5-5",
    "--effort",
    "high",
    "--settings",
    '{"fastMode":true}',
  ]);
  const plain = claudeLaunchCommand(BASE, { promptPath: "/p", createSessionId: "id" });
  expect(plain).not.toContain("--model");
  expect(plain).not.toContain("--effort");
  expect(plain).not.toContain("--settings");
});

test("a launched Claude process sees no CLAUDECODE even when the host and launch set it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-claude-launch-env-"));
  try {
    const workspace = join(directory, "workspace");
    const bin = join(directory, "bin");
    await mkdir(workspace);
    await mkdir(bin);
    const out = join(directory, "seen");
    const executable = join(bin, "claude");
    await writeFile(
      executable,
      '#!/bin/sh\nprintf "%s|%s" "${CLAUDECODE-unset}" "$*" > "$COFORGE_SEEN"\nexec "$COFORGE_BUN_EXEC" "$COFORGE_CLAUDE_FIXTURE" -- "$@"\n',
    );
    await chmod(executable, 0o755);
    const session = await new ClaudeCodeProvider().createAgentSession({
      agentWorkspaceDirectory: workspace,
      instructions: "Test Agent instructions.",
      environment: {
        PATH: bin,
        CLAUDECODE: "1",
        COFORGE_SEEN: out,
        COFORGE_BUN_EXEC: process.execPath,
        COFORGE_CLAUDE_FIXTURE: new URL("./fixtures/claude-stream-json.ts", import.meta.url)
          .pathname,
      },
    });
    const seen = await readFile(out, "utf8");
    expect(seen.startsWith("unset|")).toBe(true);
    expect(seen).toContain(`--disallowed-tools ${DISALLOWED}`);
    await session.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the one-shot CLI environment drops CLAUDECODE from the host and from overrides", () => {
  expect(claudeCliEnvironment().CLAUDECODE).toBeUndefined();
  expect(claudeCliEnvironment({ CLAUDECODE: "1" }).CLAUDECODE).toBeUndefined();
  expect(claudeCliEnvironment().TZ).toBe("UTC");
});

test("the version probe drops CLAUDECODE for Claude only", async () => {
  const seen = new Map<string, string | undefined>();
  const runtimes = await discoverExternalCodeAgents(
    {
      which: (name) => `/bin/${name}`,
      spawn: (executable, env) => {
        seen.set(executable, env?.CLAUDECODE);
        return { stdout: new Blob(["1.2.3\n"]).stream(), exited: Promise.resolve(0) };
      },
    },
    { PATH: "/bin", CLAUDECODE: "1" },
  );
  expect(runtimes.length).toBeGreaterThan(1);
  expect(seen.get("/bin/claude")).toBeUndefined();
  expect(seen.has("/bin/claude")).toBe(true);
  const others = [...seen].filter(([executable]) => executable !== "/bin/claude");
  expect(others.length).toBeGreaterThan(0);
  for (const [, marker] of others) expect(marker).toBe("1");
});

test("other providers' Agent environment keeps CLAUDECODE", () => {
  expect(agentEnvironment(undefined, { CLAUDECODE: "1" }).CLAUDECODE).toBe("1");
});
