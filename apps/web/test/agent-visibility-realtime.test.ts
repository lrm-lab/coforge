import { expect, spyOn, test } from "bun:test";

import {
  createAgentDirectoryChangedPublisher,
  publishAgentDirectoryChanged,
  createAgentVisibilityChangedPublisher,
} from "#src/server/agents/agent-visibility-realtime.server";
import { agentStatusChannel } from "#src/features/agents/agent-status-channel";

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

test("a failed directory publish is logged, not thrown, because the write already committed", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const publish = createAgentDirectoryChangedPublisher({
      publishJson: async () => {
        throw new Error("Centrifugo unavailable");
      },
    });

    await expect(publish("workspace-1", "agent-1", "created")).resolves.toBeUndefined();

    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      {
        event: "agent_directory:publish_failed",
        workspace_id: "workspace-1",
        agent_id: "agent-1",
        kind: "created",
        error_type: "Error",
      },
    ]);
  } finally {
    warn.mockRestore();
  }
});

test("the production directory publish also resolves when no Centrifugo client can be built", async () => {
  const saved = {
    url: process.env.COFORGE_CENTRIFUGO_API_URL,
    key: process.env.COFORGE_CENTRIFUGO_API_KEY,
  };
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    delete process.env.COFORGE_CENTRIFUGO_API_URL;
    delete process.env.COFORGE_CENTRIFUGO_API_KEY;

    await expect(
      publishAgentDirectoryChanged("workspace-1", "agent-1", "updated"),
    ).resolves.toBeUndefined();

    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)).event)).toEqual([
      "agent_directory:publish_failed",
    ]);
  } finally {
    warn.mockRestore();
    if (saved.url === undefined) delete process.env.COFORGE_CENTRIFUGO_API_URL;
    else process.env.COFORGE_CENTRIFUGO_API_URL = saved.url;
    if (saved.key === undefined) delete process.env.COFORGE_CENTRIFUGO_API_KEY;
    else process.env.COFORGE_CENTRIFUGO_API_KEY = saved.key;
  }
});
