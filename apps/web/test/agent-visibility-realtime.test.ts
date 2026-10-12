import { expect, test } from "bun:test";

import {
  createAgentDirectoryChangedPublisher,
  createAgentVisibilityChangedPublisher,
} from "#src/server/agents/agent-visibility-realtime.server";
import { agentStatusChannel } from "#src/features/agents/agent-status-realtime";

// After a visibility change commits, every already-connected browser learns about it through the
// existing shared status channel. The status event also invalidates the mention directory in the
// client, so no second publication is needed for this existing change type.
test("publishes an id-only visibility event on the shared status channel", async () => {
  const published: Array<{ channel: string; data: unknown }> = [];
  const publish = createAgentVisibilityChangedPublisher({
    publishJson: async (channel, data) => {
      published.push({ channel, data });
    },
  });

  await publish("workspace-1", "agent-1");

  expect(published).toEqual([
    {
      channel: agentStatusChannel("workspace-1"),
      data: { type: "agent:visibility_changed", agentId: "agent-1" },
    },
  ]);
});

test("propagates a publish failure rather than swallowing it", async () => {
  const publish = createAgentVisibilityChangedPublisher({
    publishJson: async () => {
      throw new Error("Centrifugo unavailable");
    },
  });

  await expect(publish("workspace-1", "agent-1")).rejects.toThrow("Centrifugo unavailable");
});

test("publishes an id-only directory change for roster writes", async () => {
  const published: Array<{ channel: string; data: unknown }> = [];
  const publish = createAgentDirectoryChangedPublisher({
    publishJson: async (channel, data) => {
      published.push({ channel, data });
    },
  });

  await publish("workspace-1", "agent-1", "created");

  expect(published).toEqual([
    {
      channel: agentStatusChannel("workspace-1"),
      data: { type: "agent.changed.v1", agentId: "agent-1", kind: "created" },
    },
  ]);
});
