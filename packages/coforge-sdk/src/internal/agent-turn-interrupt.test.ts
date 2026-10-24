import { expect, test } from "bun:test";
import {
  decodeAgentTurnInterruptIntent,
  decodeAgentTurnInterruptResult,
  encodeAgentTurnInterruptIntent,
  encodeAgentTurnInterruptResult,
  type AgentTurnInterruptIntent,
  type AgentTurnInterruptResult,
} from "./agent-turn-interrupt";

const intent: AgentTurnInterruptIntent = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  provider: "codex",
  epoch: 2,
  launchId: "launch-1",
};

test("turn interrupt intent and result round-trip with bounded optional facts", () => {
  const result: AgentTurnInterruptResult = {
    ...intent,
    status: "restarted",
    toolName: "bash",
    silentForMs: 600_000,
  };

  expect(decodeAgentTurnInterruptIntent(encodeAgentTurnInterruptIntent(intent))).toEqual(intent);
  expect(decodeAgentTurnInterruptResult(encodeAgentTurnInterruptResult(result))).toEqual(result);
});

test("turn interrupt codec rejects an invalid status and unsafe tool name", () => {
  expect(() =>
    encodeAgentTurnInterruptResult({
      ...intent,
      status: "failed" as "restarted",
    }),
  ).toThrow("status");
  expect(() =>
    encodeAgentTurnInterruptResult({
      ...intent,
      status: "interrupted",
      toolName: "\nunsafe",
    }),
  ).toThrow("tool name");
});
