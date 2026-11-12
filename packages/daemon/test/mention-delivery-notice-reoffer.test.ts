import { expect, test } from "bun:test";
import { harness } from "./fixtures/mention-delivery-harness";

/** Longer than `DeliveryConsumptionWatch`'s turn-end grace, so its boundary has been crossed. */
const pastGrace = () => new Promise((resolve) => setTimeout(resolve, 400));

test("a notice written as the turn ends is written again once, without a second ACK", async () => {
  const { runtime, frames, notices, deliver, emit, envelope, frameSent } = await harness();
  try {
    emit({ type: "progress" });
    await deliver(1, envelope(1));
    expect(notices).toHaveLength(1);
    emit({ type: "completed", status: "completed" });
    await frameSent((frame) => frame.kind === "ack" && frame.deliveryId === "delivery-1");
    await pastGrace();
    expect(notices).toHaveLength(2);
    // The words again, never the message: the body itself never reaches the session.
    expect(notices[1]).toBe(notices[0]!);
    expect(frames.filter((frame) => frame.kind === "ack")).toHaveLength(1);
  } finally {
    await runtime.stop();
  }
});

test("a second unconsumed boundary does not write it a third time", async () => {
  const { runtime, notices, deliver, emit, envelope, frameSent } = await harness();
  try {
    emit({ type: "progress" });
    await deliver(1, envelope(1));
    emit({ type: "completed", status: "completed" });
    await frameSent((frame) => frame.kind === "ack" && frame.deliveryId === "delivery-1");
    await pastGrace();
    expect(notices).toHaveLength(2);
    emit({ type: "completed", status: "completed" });
    await pastGrace();
    expect(notices).toHaveLength(2);
  } finally {
    await runtime.stop();
  }
});

test("a notice the turn consumed is never written again", async () => {
  const { runtime, notices, deliver, emit, envelope } = await harness();
  try {
    await deliver(1, envelope(1));
    expect(notices).toHaveLength(1);
    emit({
      type: "tool-start",
      id: "call-1",
      name: "Bash",
      input: { command: "coforge message read" },
    });
    emit({ type: "completed", status: "completed" });
    await pastGrace();
    expect(notices).toHaveLength(1);
  } finally {
    await runtime.stop();
  }
});
