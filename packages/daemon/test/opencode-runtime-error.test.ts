import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeProvider } from "@lrm/coforge-anvil/opencode";
import { type AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { perTurnSessionHost } from "#src/code-agent/per-turn-host";
import {
  RUNTIME_ERROR_CLASS,
  classifyRuntimeErrorText,
} from "#src/agent-runtime/runtime-error-classification";
import { readVersionOutput } from "#src/code-agent/version-probe";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

const INSTRUCTIONS = "Standing OpenCode instructions.";
const provider = () =>
  new OpenCodeProvider({
    command: [process.execPath, anvilRuntimeFixtures.opencode],
    host: perTurnSessionHost,
    versionReader: readVersionOutput,
  });

test("OpenCode quota errors retain the daemon rate-limit classification", async () => {
  // 2026-09-23: OpenCode Zen exhausted its pool and every turn ended as an unexplainable
  // "Agent runtime failed." because the envelope's cause rode fields the adapter never read.
  // The surfaced text must carry the classification the operator needs to act on.
  const directory = await mkdtemp(join(tmpdir(), "opencode-quota-"));
  try {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      environment: {
        COFORGE_OPENCODE_MODE: "provider-quota",
        COFORGE_OPENCODE_TURN_DELAY_MS: "120",
      },
    });
    try {
      const events: AgentRuntimeEvent[] = [];
      const completed = new Promise<void>((resolve) => {
        session.subscribe((event) => {
          events.push(event);
          if (event.type === "completed") resolve();
        });
      });
      await completed;
      expect(events).toContainEqual({
        type: "error",
        message: "provider.quota (HTTP 429): Rate limit exceeded. Please try again later.",
      });
      expect(events).toContainEqual({ type: "completed", status: "failed" });
      // The surfaced text is what the daemon classifies on — pin the classification itself, not
      // just the string, so rewording the prefix cannot silently demote the rate_limited class
      // (and its retry decision) back to generic.
      const error = events.find((event) => event.type === "error");
      const surfaced = error && error.type === "error" ? error.message : "";
      expect(classifyRuntimeErrorText(surfaced).errorClass).toBe(RUNTIME_ERROR_CLASS.RATE_LIMIT);
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
