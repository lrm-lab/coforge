import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import {
  PROCESS_TREE_EXIT_GRACE_MS,
  VERSION_PROBE_TIMEOUT_MS,
  type AgentRuntimeEvent,
} from "@lrm/coforge-anvil";
import { antigravityProvider } from "./fixtures/antigravity-host";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

test(
  "SSH session variables never reach the agy turn",
  async () => {
    const session = await antigravityProvider({
      command: [process.execPath, anvilRuntimeFixtures.antigravity],
    }).createAgentSession({
      agentWorkspaceDirectory: tmpdir(),
      instructions: "Standing Antigravity instructions.",
      sessionId: "existing",
      environment: {
        COFORGE_AGY_MODE: "text",
        COFORGE_AGY_LAUNCH_LOG: "",
        SSH_CLIENT: "10.0.0.1 1 22",
        SSH_TTY: "/dev/ttys001",
      },
    });
    const events: AgentRuntimeEvent[] = [];
    const done = Promise.withResolvers<void>();
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "completed") done.resolve();
    });
    try {
      // The fixture exits 1 if any SSH variable leaked.
      await session.sendMessage("hi");
      await done.promise;
      expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });
    } finally {
      await session.dispose();
    }
  },
  VERSION_PROBE_TIMEOUT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS,
);
