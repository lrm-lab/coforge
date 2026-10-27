import { computerKind } from "./computer-identity";
import { upgradeSlotState, type ComputerUpgradeRequest } from "./computer-upgrade-slot-state";
import type { ComputerUpgradeOutcome } from "./upgrade-failure";

/** Upgrade slots for the Version and Image rows on the computer detail panel. */
export function computerDetailUpgradeSlots(input: {
  kind: string;
  computerVersion?: string | null;
  imageVersion?: string | null;
  imageUpdate?: { version: string } | null;
  upgrade: ComputerUpgradeOutcome | { state: "idle" };
  request: ComputerUpgradeRequest;
  latestComputerVersion: string | null | undefined;
}) {
  const isCloud = computerKind(input.kind) === "cloud";
  const upgrade = input.upgrade;
  const runtimeSucceeded =
    input.request.state !== "idle" &&
    input.request.target === "runtime" &&
    upgrade.state === "succeeded";
  const imageSucceeded =
    input.request.state !== "idle" &&
    input.request.target === "image" &&
    upgrade.state === "succeeded";
  const currentVersion =
    upgrade.state === "succeeded" && (!isCloud || runtimeSucceeded)
      ? upgrade.version
      : input.computerVersion;
  const currentImageVersion = isCloud && imageSucceeded ? upgrade.version : input.imageVersion;
  const runtimeSlot = upgradeSlotState({
    upgrade,
    request: input.request,
    slot: "runtime",
    computer: input,
    currentVersion,
    latestComputerVersion: input.latestComputerVersion,
  });
  const imageSlot = isCloud
    ? upgradeSlotState({
        upgrade,
        request: input.request,
        slot: "image",
        computer: input,
        currentVersion: currentImageVersion,
        latestComputerVersion: input.latestComputerVersion,
        offer:
          upgrade.state === "succeeded" &&
          input.request.state !== "idle" &&
          input.request.target === "image"
            ? null
            : (input.imageUpdate?.version ?? null),
      })
    : null;
  return {
    isCloud,
    currentVersion,
    currentImageVersion,
    runtimeSlot,
    imageSlot,
    runtimeOffer: runtimeSlot && "offer" in runtimeSlot ? runtimeSlot.offer : undefined,
    imageOffer: imageSlot && "offer" in imageSlot ? imageSlot.offer : undefined,
  };
}
