import { expect, test } from "bun:test";
import { TurnEvidenceLedger } from "#src/agent-runtime/turn-evidence";
import { AgentDeliveryGate } from "#src/daemon-runtime/agent-delivery-gate";
import { RuntimeErrorDeliveryHold } from "#src/daemon-runtime/runtime-error-delivery-hold";
import { classifyRuntimeError } from "#src/agent-runtime/runtime-error-classification";
import {
  buildRuntimeErrorActivity,
  buildRuntimeErrorFenceActivity,
} from "#src/agent-runtime/runtime-error-activity";

const strictLedger = () => new TurnEvidenceLedger({ bareCompletionIsEmpty: true });

test("a runtime not known to report events for every turn keeps judging by events alone", () => {
  const ledger = new TurnEvidenceLedger();
  ledger.markOpened();
  expect(ledger.finish("completed")).toBeUndefined();
});

test("a turn the daemon opened and the runtime closed with no event at all is zero-evidence", () => {
  const ledger = strictLedger();
  ledger.markOpened();
  expect(ledger.finish("completed")?.providerErrorReason).toBe("zero_evidence_turn_completed");
});

test("a turn the daemon did not open, with no event, stays a quiet turn", () => {
  expect(strictLedger().finish("completed")).toBeUndefined();
});

test("an opened turn that wrote through the agent API, spoke, or ran a tool is not empty", () => {
  const wrote = strictLedger();
  wrote.markOpened();
  wrote.noteMessageSent();
  expect(wrote.finish("completed")).toBeUndefined();

  const spoke = strictLedger();
  spoke.markOpened();
  spoke.observe({ type: "text-delta", text: "OK" });
  expect(spoke.finish("completed")).toBeUndefined();

  const worked = strictLedger();
  worked.markOpened();
  worked.observe({ type: "tool-start", toolCallId: "t1", name: "shell", input: {} } as never);
  expect(worked.finish("completed")).toBeUndefined();
});

test("an opened turn that was interrupted, failed or exempt is not judged empty", () => {
  for (const status of ["interrupted", "failed"] as const) {
    const ledger = strictLedger();
    ledger.markOpened();
    expect(ledger.finish(status)).toBeUndefined();
  }
  const maintenance = strictLedger();
  maintenance.markOpened();
  maintenance.markExempt();
  expect(maintenance.finish("completed")).toBeUndefined();
});

test("the opened mark does not carry into the next turn", () => {
  const ledger = strictLedger();
  ledger.markOpened();
  expect(ledger.finish("completed")).toBeDefined();
  expect(ledger.finish("completed")).toBeUndefined();
});

test("five bare empty turns in a row reach the zero-evidence cap", () => {
  const hold = new RuntimeErrorDeliveryHold({
    deliveryGate: new AgentDeliveryGate(),
    flush: () => {},
  });
  const ledger = strictLedger();
  const results = [];
  for (let turn = 0; turn < 5; turn += 1) {
    ledger.markOpened();
    const error = ledger.finish("completed")!;
    results.push(
      hold.noteFailure(
        "agent-a",
        classifyRuntimeError({ message: error.message }),
        "zero_evidence_turn_completed",
      ),
    );
  }
  expect(results.slice(0, 4)).toEqual([undefined, undefined, undefined, undefined]);
  expect(results[4]).toEqual({
    fingerprint: "zero_evidence_turn_completed",
    attempts: 5,
    fenced: true,
  });
});

test("the cap's Activity names the zero-evidence stop, not a generic repeated-error stop", () => {
  const hold = new RuntimeErrorDeliveryHold({
    deliveryGate: new AgentDeliveryGate(),
    flush: () => {},
  });
  const ledger = strictLedger();
  const turns = Array.from({ length: 5 }, () => {
    ledger.markOpened();
    return ledger.finish("completed")!;
  });
  const last = turns[4]!;
  const classified = classifyRuntimeError({ message: last.message });
  const fence = turns.reduce<ReturnType<typeof hold.noteFailure>>(
    (state) => hold.noteFailure("agent-a", classified, "zero_evidence_turn_completed") ?? state,
    undefined,
  );
  const activity = buildRuntimeErrorFenceActivity(
    buildRuntimeErrorActivity(last, classified),
    fence!,
    last,
  );
  expect(activity.level).toBe("error");
  expect(activity.detail).toBe(
    "The runtime ended 5 turns in a row without any output, so CoForge stopped restarting it. Restart the Agent to try again.",
  );
  expect(activity.runtimeError?.errorReason).toBe("runtime_error_fenced");
});
