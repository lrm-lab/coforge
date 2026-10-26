import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeProvider } from "./fixtures/claude-provider";

const TEST_AGENT_INSTRUCTIONS = "Test Agent instructions.";

async function installFixtureCli(directory: string) {
  const agentWorkspaceDirectory = join(directory, "workspace");
  const binDirectory = join(directory, "bin");
  await mkdir(agentWorkspaceDirectory);
  await mkdir(binDirectory);
  const executable = join(binDirectory, "claude");
  await writeFile(
    executable,
    '#!/bin/sh\nprintf "%s" "$*" > "$COFORGE_CLAUDE_ARGS"\nexec "$COFORGE_BUN_EXEC" "$COFORGE_CLAUDE_FIXTURE" -- "$@"\n',
  );
  await chmod(executable, 0o755);
  return { agentWorkspaceDirectory, binDirectory, argumentsFile: join(directory, "claude-args") };
}

test("Claude Code applies Fast mode with --settings only when the launch requests it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-claude-fast-"));
  const { agentWorkspaceDirectory, binDirectory, argumentsFile } =
    await installFixtureCli(directory);

  try {
    const session = await claudeProvider().createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
      runtime: {
        provider: "claude-code",
        model: "claude-opus-5-5",
        modelProvider: "",
        reasoning: "high",
        fastMode: true,
      },
      environment: {
        PATH: binDirectory,
        COFORGE_BUN_EXEC: process.execPath,
        COFORGE_CLAUDE_FIXTURE: anvilRuntimeFixtures.claudeStreamJson,
        COFORGE_CLAUDE_ARGS: argumentsFile,
      },
    });
    expect(await readFile(argumentsFile, "utf8")).toContain('--settings {"fastMode":true}');
    await session.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Claude launch that asks for nothing sends no settings override at all", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-claude-no-fast-"));
  const { agentWorkspaceDirectory, binDirectory, argumentsFile } =
    await installFixtureCli(directory);

  try {
    const session = await claudeProvider().createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
      runtime: {
        provider: "claude-code",
        model: "claude-sonnet-5",
        modelProvider: "",
        reasoning: "high",
      },
      environment: {
        PATH: binDirectory,
        COFORGE_BUN_EXEC: process.execPath,
        COFORGE_CLAUDE_FIXTURE: anvilRuntimeFixtures.claudeStreamJson,
        COFORGE_CLAUDE_ARGS: argumentsFile,
      },
    });
    expect(await readFile(argumentsFile, "utf8")).not.toContain("--settings");
    await session.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
