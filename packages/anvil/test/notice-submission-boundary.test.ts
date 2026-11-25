import { expect, test } from "bun:test";
import { AgentNoticeSuppressedError } from "@coforge/agent";
import { CodexProvider } from "@lrm/coforge-anvil/codex";
import { tmpdir } from "node:os";
import { controlledClaude } from "./fixtures/claude-feed";
import { fixtureCodexHost } from "./fixtures/codex-host";

test("native Codex rechecks notices after the starting RPC before steering", async () => {
  const session = await new CodexProvider({
    host: fixtureCodexHost,
    command: [
      process.execPath,
      new URL("./fixtures/codex-app-server.ts", import.meta.url).pathname,
    ],
  }).createAgentSession({ agentWorkspaceDirectory: tmpdir(), instructions: "Test instructions." });
  const boundaries: string[] = [];
  try {
    const starting = session.sendMessage("wait");
    const admitted = session.notify!("read before steer", {
      prepareSubmission(boundary) {
        boundaries.push(boundary);
        return undefined;
      },
    });
    await starting;
    await expect(admitted).rejects.toBeInstanceOf(AgentNoticeSuppressedError);
    expect(boundaries).toEqual(["steer"]);
    await session.notify!("fresh notice");
  } finally {
    await session.dispose();
  }
});

test("Claude rechecks an enqueued notice when the next boundary releases it", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  let pending = true;
  const boundaries: string[] = [];
  try {
    await session.sendMessage("wait");
    await emit({ type: "result", subtype: "success" });
    await session.sendMessage("wait");
    const admitted = session.notify!("stale after admission", {
      prepareSubmission(boundary) {
        boundaries.push(boundary);
        return pending ? "actually unread" : undefined;
      },
    });
    const outcome = admitted.catch((error: unknown) => error);
    expect(boundaries).toEqual([]);
    pending = false;
    await emit({ type: "result", subtype: "success" });
    expect(await outcome).toBeInstanceOf(AgentNoticeSuppressedError);
    expect(boundaries).toHaveLength(1);
  } finally {
    await fixture.dispose();
  }
});
