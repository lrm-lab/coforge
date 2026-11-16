import { expect, test } from "bun:test";
import {
  AGENT_STALE_RUNTIME_STOP_MESSAGE_TYPE,
  decodeAgentStaleRuntimeStop,
  encodeAgentStaleRuntimeStop,
} from "./index";

const stop = {
  protocolMajor: 1,
  requestId: "stop-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  controlEpoch: 9,
};

test("round-trips the server's stale runtime stop envelope", () => {
  expect(decodeAgentStaleRuntimeStop(encodeAgentStaleRuntimeStop(stop))).toEqual(stop);
  expect(AGENT_STALE_RUNTIME_STOP_MESSAGE_TYPE).toBe("coforge.rpc.v1.AgentStaleRuntimeStop");
});

test("rejects an invalid stale runtime stop scope or epoch", () => {
  expect(() => encodeAgentStaleRuntimeStop({ ...stop, computerId: "" })).toThrow();
  expect(() => encodeAgentStaleRuntimeStop({ ...stop, controlEpoch: 0 })).toThrow();
});
