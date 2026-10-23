import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRuntimeEvent } from "#src/code-agent/contract";
import { scenarioProvider, waitForEvent } from "./codex-scenarios";

test("Codex answers an app-server request with method not found so the turn can finish", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-codex-server-request-"));
  const session = await scenarioProvider().createAgentSession({
    agentWorkspaceDirectory,
    instructions: "Test Agent instructions.",
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("server-request");
    await waitForEvent(events, "completed");
    // The rejected request surfaces no runtime event of its own.
    expect(events.map((event) => event.type).filter((type) => type !== "session")).toEqual([
      "thinking-delta",
      "completed",
    ]);
  } finally {
    await session.dispose();
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});
