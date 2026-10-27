import { expect, test } from "bun:test";

import { computerDetailUpgradeSlots } from "#src/features/computers/computer-detail-upgrade-slots";

test("a cloud computer keeps runtime and image upgrade slots separate", () => {
  const slots = computerDetailUpgradeSlots({
    kind: "cloud",
    computerVersion: "0.1.7-dev.1",
    imageVersion: "0.1.7-dev.8",
    imageUpdate: { version: "0.1.8-dev.3" },
    upgrade: { state: "idle" },
    request: { state: "idle" },
    latestComputerVersion: "0.1.8-dev.3",
  });

  expect(slots.runtimeSlot).toEqual({ state: "available", offer: "0.1.8-dev.3" });
  expect(slots.imageSlot).toEqual({ state: "available", offer: "0.1.8-dev.3" });
});

test("a runtime upgrade in progress paints only the Version slot", () => {
  const slots = computerDetailUpgradeSlots({
    kind: "cloud",
    computerVersion: "0.1.8-dev.5",
    imageVersion: "33f4b5bd4c1b",
    imageUpdate: { version: "0.1.14-dev.4" },
    upgrade: { state: "running", version: "0.1.14-dev.4" },
    request: {
      state: "accepted",
      requestId: "req-1",
      version: "0.1.14-dev.4",
      target: "runtime",
    },
    latestComputerVersion: "0.1.14-dev.4",
  });

  expect(slots.runtimeSlot).toEqual({
    state: "upgrading",
    version: "0.1.14-dev.4",
    delivered: true,
  });
  expect(slots.imageSlot).toEqual({ state: "available", offer: "0.1.14-dev.4" });
});

test("a recovered runtime upgrade without a local request still stays off the Image row", () => {
  const slots = computerDetailUpgradeSlots({
    kind: "cloud",
    computerVersion: "0.1.8-dev.5",
    imageVersion: "33f4b5bd4c1b",
    imageUpdate: { version: "0.1.9-dev.1" },
    upgrade: { state: "running", version: "0.1.14-dev.4" },
    request: { state: "idle" },
    upgradeTarget: "runtime",
    latestComputerVersion: "0.1.14-dev.4",
  });

  expect(slots.runtimeSlot?.state).toBe("upgrading");
  expect(slots.imageSlot).toEqual({ state: "available", offer: "0.1.9-dev.1" });
});
