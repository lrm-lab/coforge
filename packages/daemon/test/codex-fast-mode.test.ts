import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexProvider } from "#src/code-agent/codex/provider";
import type { AgentRuntimeEvent } from "#src/code-agent/contract";

const TEST_AGENT_INSTRUCTIONS = "Test Agent instructions.";

async function waitForEvent(events: AgentRuntimeEvent[], type: AgentRuntimeEvent["type"]) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (events.some((event) => event.type === type)) return;
    await Bun.sleep(2);
  }
  throw new Error(`timed out waiting for ${type}`);
}

test("Codex asks for the Fast service tier only when the launch requests it", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-codex-fast-"));
  const skillDirectory = join(agentWorkspaceDirectory, ".agents", "skills", "fixture-skill");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: fixture-skill\ndescription: Fixture skill\n---\n",
  );
  // The fixture rejects thread/start unless `serviceTier` is exactly "fast", so a regression that
  // drops the tier fails session creation rather than passing silently.
  const adapter = new CodexProvider({
    command: [
      process.execPath,
      new URL("./fixtures/codex-app-server.ts", import.meta.url).pathname,
      "expected-skill=fixture-skill",
      "expected-coforge-environment",
      "expected-runtime-config",
      "expected-fast-mode",
    ],
  });

  try {
    const session = await adapter.createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
      runtime: {
        provider: "codex",
        model: "gpt-5.6-sol",
        modelProvider: "",
        reasoning: "high",
        fastMode: true,
      },
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.sendMessage("finish");
    await waitForEvent(events, "completed");
    // codex's own thread/start reply said it applied the priority (Fast) tier.
    expect(events.filter((event) => event.type === "service-tier")).toEqual([
      { type: "service-tier", state: "on" },
    ]);
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("a Codex launch that asks for nothing reports no service tier at all", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-codex-no-fast-"));
  const adapter = new CodexProvider({
    command: [
      process.execPath,
      new URL("./fixtures/codex-app-server.ts", import.meta.url).pathname,
    ],
  });

  try {
    const session = await adapter.createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.sendMessage("finish");
    await waitForEvent(events, "completed");
    expect(events.filter((event) => event.type === "service-tier")).toEqual([]);
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});
