import { describe, expect, test } from "bun:test";
import { decodeAgentServerFeatures, encodeAgentServerFeatures } from "./agent-server-features";

const value = {
  protocolMajor: 1 as const,
  requestId: "flag_123",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  revision: 1,
  agentIds: ["agent-1", "agent-2"],
  agentContextView: true,
};

describe("agent server feature publication", () => {
  test("round trips a scoped explicit feature value", () => {
    expect(decodeAgentServerFeatures(encodeAgentServerFeatures(value))).toEqual(value);
  });

  test("preserves an omitted feature as unknown", () => {
    const unknown = { ...value, agentContextView: undefined };
    expect(decodeAgentServerFeatures(encodeAgentServerFeatures(unknown))).toEqual(unknown);
  });

  test("rejects invalid scope and revision", () => {
    expect(() => encodeAgentServerFeatures({ ...value, workspaceId: "" })).toThrow();
    expect(() => encodeAgentServerFeatures({ ...value, revision: 0 })).toThrow();
  });
});
