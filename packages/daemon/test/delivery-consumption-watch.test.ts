import { expect, test } from "bun:test";
import { DeliveryConsumptionWatch } from "#src/daemon-runtime/delivery-consumption-watch";

const delivery = (deliveryId: string) => ({ deliveryId });

test("tracks writes per launch and settles one delivery per matching runtime signal", () => {
  const watch = new DeliveryConsumptionWatch({ now: () => 1234 });
  const launch = {};
  watch.recordWrite("agent-1", "launch-1", launch, delivery("delivery-1"));
  watch.recordWrite("agent-1", "launch-1", launch, delivery("delivery-2"));
  expect(watch.snapshot("agent-1")).toMatchObject({
    launchId: "launch-1",
    pendingWrites: 2,
    firstPendingAtMs: 1234,
    lastDeliveryId: "delivery-2",
  });
  watch.recordConsumption("agent-1", "launch-1", launch, "text-delta");
  expect(watch.snapshot("agent-1")).toMatchObject({ pendingWrites: 1 });
  watch.recordConsumption("agent-1", "launch-1", launch, "tool-start");
  expect(watch.snapshot("agent-1")).toBeUndefined();
});

test("a late event from an old launch cannot clear the current launch", () => {
  const watch = new DeliveryConsumptionWatch({ now: () => 1234 });
  const oldLaunch = {};
  const newLaunch = {};
  watch.recordWrite("agent-1", "launch-old", oldLaunch, delivery("delivery-old"));
  watch.recordWrite("agent-1", "launch-new", newLaunch, delivery("delivery-new"));
  watch.recordConsumption("agent-1", "launch-old", oldLaunch, "completed");
  expect(watch.snapshot("agent-1")).toMatchObject({
    launchId: "launch-new",
    lastDeliveryId: "delivery-new",
  });
});

test("a wake that reuses launchId cannot let the old process settle the new delivery", () => {
  const watch = new DeliveryConsumptionWatch({ now: () => 1234 });
  const oldLaunch = {};
  const newLaunch = {};
  watch.recordWrite("agent-1", "launch-reused", oldLaunch, delivery("delivery-old"));
  watch.recordWrite("agent-1", "launch-reused", newLaunch, delivery("delivery-new"));
  watch.observeRuntimeEvent("agent-1", "launch-reused", oldLaunch, {
    type: "completed",
    status: "completed",
  });
  expect(watch.snapshot("agent-1")).toMatchObject({
    launchId: "launch-reused",
    lastDeliveryId: "delivery-new",
  });
});

test("runtime events map to consumption or error settlement", () => {
  const watch = new DeliveryConsumptionWatch({ now: () => 1234 });
  const launch = {};
  watch.recordWrite("agent-1", "launch-1", launch, delivery("delivery-1"));
  watch.observeRuntimeEvent("agent-1", "launch-1", launch, {
    type: "thinking-delta",
    text: "",
  });
  expect(watch.snapshot("agent-1")).toBeUndefined();
  watch.recordWrite("agent-1", "launch-1", launch, delivery("delivery-2"));
  watch.observeRuntimeEvent("agent-1", "launch-1", launch, {
    type: "error",
    message: "provider failed",
  });
  expect(watch.snapshot("agent-1")).toBeUndefined();
});

test("a completed turn does not settle a delivery, and stale observations expire", () => {
  let now = 1234;
  const watch = new DeliveryConsumptionWatch({ now: () => now });
  const launch = {};
  watch.recordWrite("agent-1", "launch-1", launch, delivery("delivery-1"));
  watch.observeRuntimeEvent("agent-1", "launch-1", launch, {
    type: "completed",
    status: "completed",
  });
  expect(watch.snapshot("agent-1")).toMatchObject({ pendingWrites: 1 });
  now += 30_001;
  expect(watch.snapshot("agent-1")).toBeUndefined();
});

const boundaryHarness = () => {
  let now = 1234;
  const written: {
    agentId: string;
    notices: { deliveryIds: readonly string[]; text: string }[];
  }[] = [];
  const watch = new DeliveryConsumptionWatch({
    now: () => now,
    reoffer: (agentId, notices) => {
      written.push({ agentId, notices: [...notices] });
    },
  });
  const launch = {};
  /** A turn ends; reading the watch after the grace has passed is what crosses its boundary. */
  const turnEnded = () => {
    watch.observeRuntimeEvent("agent-1", "launch-1", launch, {
      type: "completed",
      status: "completed",
    });
    now += 300;
  };
  return { watch, launch, written, turnEnded, snapshot: () => watch.snapshot("agent-1") };
};

test("a notice a turn boundary leaves unconsumed is written again exactly once", () => {
  const { watch, launch, written, turnEnded, snapshot } = boundaryHarness();
  const text = "1 new message in #runtime (coforge message read)";
  watch.recordWrite("agent-1", "launch-1", launch, delivery("delivery-1"));
  watch.recordNotice("agent-1", ["delivery-1"], text);
  turnEnded();
  expect(snapshot()).toBeUndefined();
  expect(written).toEqual([
    { agentId: "agent-1", notices: [{ deliveryIds: ["delivery-1"], text }] },
  ]);
  // Nothing stays watched, so a further boundary owes no second offer: the watchdog takes over.
  turnEnded();
  expect(snapshot()).toBeUndefined();
  expect(written).toHaveLength(1);
});

test("a notice the model consumed is never written again", () => {
  const { watch, launch, written, turnEnded, snapshot } = boundaryHarness();
  watch.recordWrite("agent-1", "launch-1", launch, delivery("delivery-1"));
  watch.recordNotice("agent-1", ["delivery-1"], "1 new message in #runtime");
  watch.observeRuntimeEvent("agent-1", "launch-1", launch, {
    type: "tool-start",
    id: "call-1",
    name: "Read",
    input: {},
  });
  turnEnded();
  expect(snapshot()).toBeUndefined();
  expect(written).toEqual([]);
});

test("a write with no known notice text is dropped at the boundary, not written blind", () => {
  const { watch, launch, written, turnEnded, snapshot } = boundaryHarness();
  watch.recordWrite("agent-1", "launch-1", launch, delivery("delivery-1"));
  turnEnded();
  expect(snapshot()).toBeUndefined();
  expect(written).toEqual([]);
});

test("a reminder's app-item notice is written again the same way", () => {
  const { watch, launch, written, turnEnded, snapshot } = boundaryHarness();
  const text = "New app item available. Run coforge inbox check.";
  watch.recordWrite("agent-1", "launch-1", launch, {
    deliveryId: "appitem:reminder-1",
    notice: text,
  });
  turnEnded();
  snapshot();
  expect(written).toEqual([
    { agentId: "agent-1", notices: [{ deliveryIds: ["appitem:reminder-1"], text }] },
  ]);
});
