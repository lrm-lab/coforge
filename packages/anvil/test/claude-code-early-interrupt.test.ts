import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AgentRuntimeEvent,
  type AgentSession,
  PROCESS_TREE_EXIT_GRACE_MS,
} from "@lrm/coforge-anvil";

import {
  claudeFixtureProvider,
  startClaudeInitGate,
  TEST_AGENT_INSTRUCTIONS,
} from "./fixtures/claude-feed";

test(
  "Claude Code interrupts a turn the CLI had not yet answered with its init",
  async () => {
    const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-early-int-"));
    const adapter = claudeFixtureProvider();
    const initRequested = Promise.withResolvers<void>();
    const releaseInit = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const events: AgentRuntimeEvent[] = [];
    let gate: Bun.Server<undefined> | undefined;
    let session: AgentSession | undefined;
    try {
      gate = startClaudeInitGate(() => initRequested.resolve(), releaseInit.promise);
      session = await adapter.createAgentSession({
        agentWorkspaceDirectory,
        instructions: TEST_AGENT_INSTRUCTIONS,
        environment: { COFORGE_CLAUDE_INIT_GATE: gate.url.href },
      });
      session.subscribe((event) => {
        events.push(event);
        if (event.type === "completed") completed.resolve();
      });
      await session.notify!("wait");
      await initRequested.promise;
      const interrupted = session.interrupt();
      releaseInit.resolve();
      await interrupted;
      await completed.promise;
      expect(events.at(-1)).toEqual({ type: "completed", status: "interrupted" });
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(session.hasLiveTurn).toBe(false);
    } finally {
      releaseInit.resolve();
      try {
        await session?.dispose();
      } finally {
        gate?.stop(true);
        await rm(agentWorkspaceDirectory, { recursive: true, force: true });
      }
    }
  },
  5_000 + 2 * PROCESS_TREE_EXIT_GRACE_MS,
);
