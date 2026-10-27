import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_PROVIDER, RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { createCodeAgentProvider } from "#src/code-agent/registry";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

const OPENCODE_FIXTURE = anvilRuntimeFixtures.opencode;

function completed(session: {
  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void;
}): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "completed") return;
      unsubscribe();
      resolve();
    });
  });
}

test("code-agent registry exposes every supported Provider", () => {
  expect(createCodeAgentProvider(RUNTIME_PROVIDER.COFORGE).provider).toBe(RUNTIME_PROVIDER.COFORGE);
  expect(createCodeAgentProvider(RUNTIME_PROVIDER.PI).provider).toBe(RUNTIME_PROVIDER.PI);
  expect(createCodeAgentProvider(RUNTIME_PROVIDER.CODEX).provider).toBe(RUNTIME_PROVIDER.CODEX);
  expect(createCodeAgentProvider(RUNTIME_PROVIDER.CLAUDE_CODE).provider).toBe(
    RUNTIME_PROVIDER.CLAUDE_CODE,
  );
  expect(createCodeAgentProvider(RUNTIME_PROVIDER.KIRO).provider).toBe(RUNTIME_PROVIDER.KIRO);
  expect(createCodeAgentProvider(RUNTIME_PROVIDER.CURSOR).provider).toBe(RUNTIME_PROVIDER.CURSOR);
});

test("registry launches OpenCode from its installer path when PATH misses it", async () => {
  const home = await mkdtemp(join(tmpdir(), "coforge-registry-opencode-"));
  const workspace = join(home, "workspace");
  const executable = join(home, ".opencode", "bin", "opencode");
  const launchLog = join(home, "launches.jsonl");
  await mkdir(join(home, ".opencode", "bin"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  await Bun.write(
    executable,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(OPENCODE_FIXTURE)} "$@"\n`,
  );
  await chmod(executable, 0o755);

  try {
    const provider = createCodeAgentProvider(RUNTIME_PROVIDER.OPENCODE, {
      environment: { HOME: home, PATH: "/usr/bin:/bin" },
      platform: "darwin",
    });
    const session = await provider.createAgentSession({
      agentWorkspaceDirectory: workspace,
      instructions: "installer path instructions",
      environment: { COFORGE_OPENCODE_MODE: "text", COFORGE_OPENCODE_LAUNCH_LOG: launchLog },
    });
    try {
      // A fresh OpenCode session does not launch until real input. The installer-path binary is
      // the one that writes this log, and the standing instructions live in the private file.
      const done = completed(session);
      await session.sendMessage("ping");
      await done;
      const launch = JSON.parse((await Bun.file(launchLog).text()).trim()) as {
        prompt: string;
        configContent: string;
      };
      expect(launch.prompt).toBe("ping");
      const config = JSON.parse(launch.configContent) as { instructions: string[] };
      expect(await Bun.file(config.instructions[0]!).text()).toBe("installer path instructions");
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("advertised usage scanning matches each registered provider's reader", () => {
  for (const provider of Object.values(RUNTIME_PROVIDER)) {
    const runtime = createCodeAgentProvider(provider);
    expect(RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN[provider]).toBe(
      typeof runtime.readUsage === "function",
    );
  }
});
