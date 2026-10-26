import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProvider } from "./fixtures/claude-provider";
import { TEST_AGENT_INSTRUCTIONS } from "./fixtures/claude-feed";

test("Claude Code starts the user's installed CLI from PATH in streaming mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-claude-installed-"));
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
  const argumentsFile = join(directory, "claude-arguments");

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
    expect(await readFile(argumentsFile, "utf8")).toContain(
      "-p --input-format stream-json --output-format stream-json",
    );
    expect(await readFile(argumentsFile, "utf8")).toContain(
      "--model claude-sonnet-5 --effort high",
    );
    expect(await readFile(argumentsFile, "utf8")).toContain("--append-system-prompt-file");
    await session.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
