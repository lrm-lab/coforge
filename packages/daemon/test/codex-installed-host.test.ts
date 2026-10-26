import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider } from "@lrm/coforge-anvil/codex";
import { codexRuntimeHost } from "#src/code-agent/codex/host";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

const TEST_AGENT_INSTRUCTIONS = "Test Agent instructions.";

test("Codex starts the user's installed CLI from PATH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-codex-installed-"));
  const agentWorkspaceDirectory = join(directory, "workspace");
  const binDirectory = join(directory, "bin");
  await mkdir(agentWorkspaceDirectory);
  await mkdir(binDirectory);
  const executable = join(binDirectory, "codex");
  await writeFile(
    executable,
    '#!/bin/sh\nprintf started > "$COFORGE_CODEX_MARKER"\nexec "$COFORGE_BUN_EXEC" "$COFORGE_CODEX_FIXTURE" "$@"\n',
  );
  await chmod(executable, 0o755);
  const marker = join(directory, "codex-started");

  try {
    const session = await new CodexProvider({ host: codexRuntimeHost }).createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
      environment: {
        PATH: binDirectory,
        COFORGE_BUN_EXEC: process.execPath,
        COFORGE_CODEX_FIXTURE: anvilRuntimeFixtures.codex,
        COFORGE_CODEX_MARKER: marker,
      },
    });
    expect(await readFile(marker, "utf8")).toBe("started");
    await session.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
