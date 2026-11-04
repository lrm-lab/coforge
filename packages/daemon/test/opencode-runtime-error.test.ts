import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAcpProvider } from "@lrm/coforge-anvil/opencode";
import { AgentEnvironmentError, type AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { launchFailureActivity } from "#src/agent-runtime/launch-failure";
import { openCodeAcpRuntimeHost } from "#src/code-agent/opencode/acp-host";
import {
  RUNTIME_ERROR_CLASS,
  classifyRuntimeErrorText,
} from "#src/agent-runtime/runtime-error-classification";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

const INSTRUCTIONS = "Standing OpenCode instructions.";
const provider = () =>
  new OpenCodeAcpProvider({
    command: [process.execPath, anvilRuntimeFixtures.opencode],
    host: openCodeAcpRuntimeHost,
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
        OPENCODE_ACP_FIXTURE_QUOTA: "1",
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
      await session.sendMessage("go");
      await completed;
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "error",
          message: "provider.quota (HTTP 429): Rate limit exceeded. Please try again later.",
        }),
      );
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

test("an OpenCode environment refusal keeps a single period before the recovery step", () => {
  const message =
    "OpenCode cannot start because OPENCODE_CONFIG_CONTENT is already set. CoForge will not overwrite it.";
  const activity = launchFailureActivity(new AgentEnvironmentError(message), "OpenCode");
  expect(activity.detail).toBe(
    `${message} Correct it in the Agent's environment variables, then start the Agent again.`,
  );
  expect(activity.runtimeError.errorReason).toBe("agent_environment_invalid");
});
