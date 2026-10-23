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
  const currentVersion =
    !isCloud && upgrade.state === "succeeded" ? upgrade.version : input.computerVersion;
  const currentImageVersion =
    isCloud && upgrade.state === "succeeded" ? upgrade.version : input.imageVersion;
  const runtimeSlot = isCloud
    ? null
    : upgradeSlotState({
        upgrade,
        request: input.request,
        computer: input,
        currentVersion,
        latestComputerVersion: input.latestComputerVersion,
      });
  const imageSlot = isCloud
    ? upgradeSlotState({
        upgrade,
        request: input.request,
        computer: input,
        currentVersion: currentImageVersion,
        latestComputerVersion: input.latestComputerVersion,
        offer: upgrade.state === "succeeded" ? null : (input.imageUpdate?.version ?? null),
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
