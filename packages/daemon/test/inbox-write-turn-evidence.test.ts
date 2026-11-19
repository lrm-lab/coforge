import { expect, test } from "bun:test";
import { TurnEvidenceLedger } from "#src/agent-runtime/turn-evidence";
import { AgentInboxCoordinator } from "#src/daemon-runtime/agent-inbox-coordinator";

function coordinator(launches: Map<string, { turnEvidence?: TurnEvidenceLedger }>) {
  return new AgentInboxCoordinator({
    deliveryGate: {},
    currentActivityLaunch: (agentId: string) => launches.get(agentId),
  } as never);
}

test("a message or task write by the Agent counts as the open turn's evidence", () => {
  const ledger = new TurnEvidenceLedger();
  ledger.observe({ type: "thinking-delta", text: "thinking" });
  coordinator(new Map([["agent-a", { turnEvidence: ledger }]])).noteCoforgeWriteOrHold("agent-a");
  expect(ledger.finish("completed")).toBeUndefined();
});

test("a turn with no write stays zero-evidence, and an Agent without a launch is ignored", () => {
  const ledger = new TurnEvidenceLedger();
  ledger.observe({ type: "thinking-delta", text: "thinking" });
  coordinator(new Map([["agent-a", { turnEvidence: ledger }]])).noteCoforgeWriteOrHold("agent-b");
  expect(ledger.finish("completed")?.providerErrorReason).toBe("zero_evidence_turn_completed");
});
