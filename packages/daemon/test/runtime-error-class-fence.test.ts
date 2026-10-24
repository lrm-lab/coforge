import { expect, test } from "bun:test";
import {
  RuntimeErrorDeliveryHold,
  type RuntimeErrorDeliveryHoldPorts,
} from "#src/daemon-runtime/runtime-error-delivery-hold";
import { classifyRuntimeError } from "#src/agent-runtime/runtime-error-classification";
import type { RuntimeErrorClassFence } from "#src/agent-runtime/runtime-error-recovery";

type Launch = { runtimeErrorClassFence?: RuntimeErrorClassFence };
function harness() {
  const held = new Map<
    string,
    ReturnType<RuntimeErrorDeliveryHoldPorts["deliveryQueue"]["explicitHold"]>
  >();
  const hold = new RuntimeErrorDeliveryHold({
    deliveryQueue: {
      hold: (id, reason) => {
        held.set(id, reason);
      },
      release: (id) => {
        held.delete(id);
        return [];
      },
      explicitHold: (id) => held.get(id),
    },
    flush() {
      throw new Error("fenced deliveries must not be flushed");
    },
  });
  const note = (launch: Launch, message: string) => {
    const event = { type: "error", message } as const;
    return hold.noteRuntimeFailure("agent", launch, event, classifyRuntimeError(event));
  };
  return { hold, note, held };
}

test("five changing 404 errors fence across turn ends and retain the terminal delivery hold", () => {
  const { hold, note, held } = harness();
  const launch: Launch = {};
  try {
    for (let i = 0; i < 4; i++) {
      expect(note(launch, `HTTP 404: request ${i}`).fence).toBeUndefined();
      hold.noteTurnEnd("agent");
    }
    expect(note(launch, "HTTP 404: last request").fence).toMatchObject({
      attempts: 5,
      event: "agent_runtime:class_fence_tripped",
    });
    expect(held.get("agent")).toBe("fingerprint_fence");
  } finally {
    hold.disposeAll();
  }
});

test("progress resets both fences; replacement launches do not inherit class state", () => {
  const { hold, note } = harness();
  const launch: Launch = {};
  try {
    for (let i = 0; i < 4; i++) note(launch, `HTTP 404: request ${i}`);
    hold.noteRecoverySignal("agent", "output", launch.runtimeErrorClassFence);
    expect(note(launch, "HTTP 404: after output").fence).toBeUndefined();
    expect(note({}, "HTTP 404: replacement").fence).toBeUndefined();
  } finally {
    hold.disposeAll();
  }
});

test("fingerprint fence wins when the fifth 404 also reaches its repeated fingerprint threshold", () => {
  const { hold, note } = harness();
  const launch: Launch = {};
  try {
    note(launch, "HTTP 404: first");
    note(launch, "HTTP 404: second");
    note(launch, "HTTP 404: repeated");
    note(launch, "HTTP 404: repeated");
    expect(note(launch, "HTTP 404: repeated").fence?.event).toBe(
      "agent_runtime:fingerprint_fence_tripped",
    );
  } finally {
    hold.disposeAll();
  }
});
