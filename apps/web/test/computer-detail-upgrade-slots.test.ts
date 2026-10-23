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

  expect(slots.runtimeSlot).toBeNull();
  expect(slots.imageSlot).toEqual({ state: "available", offer: "0.1.8-dev.3" });
});
