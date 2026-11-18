import { expect, test } from "bun:test";
import { classifyRuntimeError } from "#src/agent-runtime/runtime-error-classification";
import type {
  RuntimeErrorClassFence,
  RuntimeErrorRecoverySignal,
} from "#src/agent-runtime/runtime-error-recovery";
import {
  RuntimeErrorDeliveryHold,
  type RuntimeErrorDeliveryHoldPorts,
} from "#src/daemon-runtime/runtime-error-delivery-hold";

type Launch = { runtimeErrorClassFence?: RuntimeErrorClassFence };

const STUCK = "the provider returned a body this runtime cannot decode";

function harness() {
  const held = new Map<
    string,
    ReturnType<RuntimeErrorDeliveryHoldPorts["deliveryGate"]["explicitHold"]>
  >();
  const hold = new RuntimeErrorDeliveryHold({
    deliveryGate: {
      hold: (id, reason) => {
        held.set(id, reason);
      },
      release: (id) => {
        held.delete(id);
        return [];
      },
      endHoldForNextLaunch: (id) => void held.delete(id),
      explicitHold: (id) => held.get(id),
      credentialHeld: (id) => held.get(id) === "credential_invalid",
      pending: () => [],
    },
    flush() {
      throw new Error("a fenced Agent's deliveries must not be flushed");
    },
  });
  const note = () => {
    const event = { type: "error", message: STUCK } as const;
    return hold.noteRuntimeFailure("agent", {} as Launch, event, classifyRuntimeError(event));
  };
  return { hold, note };
}

test("a turn that ends with nothing shown does not clear the repeat count", () => {
  const { hold, note } = harness();
  try {
    expect(note().fence).toBeUndefined();
    hold.noteTurnEnd("agent");
    expect(note().fence).toBeUndefined();
    hold.noteTurnEnd("agent");
    expect(note().fence).toMatchObject({ attempts: 3 });
  } finally {
    hold.disposeAll();
  }
});

test.each([
  "output",
  "side_output",
  "review_finished",
] as const satisfies RuntimeErrorRecoverySignal[])(
  "a turn that showed progress (%s) clears the repeat count when it ends",
  (signal) => {
    const { hold, note } = harness();
    try {
      expect(note().fence).toBeUndefined();
      expect(note().fence).toBeUndefined();
      hold.noteRecoverySignal("agent", signal);
      expect(note().fence).toBeUndefined();
      hold.noteTurnEnd("agent");
      expect(note().fence).toBeUndefined();
      expect(note().fence).toBeUndefined();
      expect(note().fence).toMatchObject({ attempts: 3 });
    } finally {
      hold.disposeAll();
    }
  },
);

test("progress before the failure in the same turn still clears the count at the turn end", () => {
  const { hold, note } = harness();
  try {
    expect(note().fence).toBeUndefined();
    expect(note().fence).toBeUndefined();
    hold.noteRecoverySignal("agent", "output");
    expect(note().fence).toBeUndefined();
    hold.noteTurnEnd("agent");
    expect(note().fence).toBeUndefined();
  } finally {
    hold.disposeAll();
  }
});

test("a compaction ending, or progress with no output, leaves the repeat count alone", () => {
  for (const signal of ["phase_finished", "progress"] as const) {
    const { hold, note } = harness();
    try {
      expect(note().fence).toBeUndefined();
      expect(note().fence).toBeUndefined();
      hold.noteRecoverySignal("agent", signal);
      hold.noteTurnEnd("agent");
      expect(note().fence).toMatchObject({ attempts: 3 });
    } finally {
      hold.disposeAll();
    }
  }
});

test("a provider usage limit ending every turn with nothing shown never trips the fence", () => {
  const { hold } = harness();
  try {
    const event = {
      type: "error",
      message: "You've hit your usage limit",
      providerLimit: {
        kind: "window_limit",
        resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    } as never;
    for (let turn = 0; turn < 4; turn += 1) {
      expect(
        hold.noteRuntimeFailure("agent", {} as Launch, event, classifyRuntimeError(event)).fence,
      ).toBeUndefined();
      hold.noteTurnEnd("agent");
    }
  } finally {
    hold.disposeAll();
  }
});
