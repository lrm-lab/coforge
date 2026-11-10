import { expect, test } from "bun:test";
import { DeliveryConsumptionWatch } from "#src/daemon-runtime/delivery-consumption-watch";

const delivery = (deliveryId: string) => ({ deliveryId });

test("tracks writes per launch and clears them on a matching runtime consumption signal", () => {
  const watch = new DeliveryConsumptionWatch(() => 1234);
  watch.recordWrite("agent-1", "launch-1", delivery("delivery-1"));
  watch.recordWrite("agent-1", "launch-1", delivery("delivery-2"));
  expect(watch.snapshot("agent-1")).toMatchObject({
    launchId: "launch-1",
    pendingWrites: 2,
    firstPendingAtMs: 1234,
    lastDeliveryId: "delivery-2",
  });
  watch.recordConsumption("agent-1", "launch-1", "text-delta");
  expect(watch.snapshot("agent-1")).toBeUndefined();
});

test("a late event from an old launch cannot clear the current launch", () => {
  const watch = new DeliveryConsumptionWatch(() => 1234);
  watch.recordWrite("agent-1", "launch-old", delivery("delivery-old"));
  watch.recordWrite("agent-1", "launch-new", delivery("delivery-new"));
  watch.recordConsumption("agent-1", "launch-old", "completed");
  expect(watch.snapshot("agent-1")).toMatchObject({
    launchId: "launch-new",
    lastDeliveryId: "delivery-new",
  });
});

test("runtime events map to consumption or error settlement", () => {
  const watch = new DeliveryConsumptionWatch(() => 1234);
  watch.recordWrite("agent-1", "launch-1", delivery("delivery-1"));
  watch.observeRuntimeEvent("agent-1", "launch-1", { type: "thinking-delta", text: "" });
  expect(watch.snapshot("agent-1")).toBeUndefined();
  watch.recordWrite("agent-1", "launch-1", delivery("delivery-2"));
  watch.observeRuntimeEvent("agent-1", "launch-1", { type: "error", message: "provider failed" });
  expect(watch.snapshot("agent-1")).toBeUndefined();
});
