import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { scenarioProvider, waitForEvent } from "./codex-scenarios";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-codex-replay-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** The error events of a turn started with `input`, as the adapter emits them. */
async function turnErrors(input: string) {
  const session = await scenarioProvider().createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: "Test.",
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage(input);
    await waitForEvent(events, "completed");
    return events.filter((event) => event.type === "error");
  } finally {
    await session.dispose();
  }
}

test("a failed turn the provider cannot decrypt reports the session recovery on its error event", async () => {
  for (const input of ["replay-rejected-code", "replay-rejected-text", "replay-rejected-details"]) {
    expect(await turnErrors(input)).toEqual([
      expect.objectContaining({
        type: "error",
        sessionRecovery: "provider_replay_rejected",
        providerErrorReason: "turn_failed",
      }),
    ]);
  }
});

test("any other failed turn reports no session recovery", async () => {
  const [error] = await turnErrors("usage-limit");
  expect(error).toMatchObject({ type: "error", providerErrorClass: "usageLimitExceeded" });
  expect(error).not.toHaveProperty("sessionRecovery");
});
