import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import {
  installAgentServerFeaturesBroadcast,
  resetAgentServerFeaturesBroadcastForTest,
} from "./agent-server-features-broadcast-composition.server";

beforeEach(() => {
  resetAgentServerFeaturesBroadcastForTest();
});

afterEach(() => {
  resetAgentServerFeaturesBroadcastForTest();
});

test("install skips the broadcast with one info log when Centrifugo is not configured", () => {
  const info = spyOn(console, "info").mockImplementation(() => {});
  try {
    const stop = installAgentServerFeaturesBroadcast({});
    expect(typeof stop).toBe("function");
    const logged = info.mock.calls.map(([line]) => String(line)).join("\n");
    expect(logged).toContain("agent_server_features_broadcast_disabled");
  } finally {
    info.mockRestore();
  }
});
