import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { kiroProvider } from "./fixtures/kiro-host";

// macOS tmpdir lives under /var, a symlink; the Kiro provider rejects a linked
// agent profile directory (comparing realpath to the literal resolved path).
const tempRoot = realpathSync(tmpdir());
const command = [process.execPath, new URL("./fixtures/kiro-acp.ts", import.meta.url).pathname];

test("a steering outcome that arrives before its steer's answer still settles correctly", async () => {
  // The synchronous update tap delivers Kiro's outcome before the `_session/steer` answer that
  // registers the steer; the steering keeps that outcome by message id until the steer arrives.
  const cwd = await mkdtemp(join(tempRoot, "kiro-steer-early-"));
  const session = await kiroProvider({ command }).createAgentSession({
    agentWorkspaceDirectory: cwd,
    instructions: "Keep the asymmetric marker 719 in the system prompt.",
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.notify!("events"); // busy; the fixture leaves this turn open
    // Injected before the answer: the model read it, so no fallback event.
    await session.notify!("steer-inject-before-answer MARKER-E");
    expect(events.filter((event) => event.type === "notice-undelivered")).toEqual([]);
    // Cleared before the answer: Kiro dropped it unread, so it must be redelivered.
    const undelivered = Promise.withResolvers<void>();
    session.subscribe((event) => {
      if (event.type === "notice-undelivered") undelivered.resolve();
    });
    await session.notify!("steer-clear-before-answer MARKER-F");
    await undelivered.promise;
    expect(events).toContainEqual({
      type: "notice-undelivered",
      text: "steer-clear-before-answer MARKER-F",
    });
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
