import { computerKind } from "./computer-identity";
import type { ComputerUpgradeStatus, ComputerUpgradeTarget } from "./computer.schemas";
import { upgradeSlotState, type ComputerUpgradeRequest } from "./computer-upgrade-slot-state";
import { computerUpgradeTarget } from "./computer-upgrade-target";
import type { ComputerUpgradeOutcome } from "./upgrade-failure";

/** Upgrade slots for the Version and Image rows on the computer detail panel. */
export function computerDetailUpgradeSlots(input: {
  kind: string;
  computerVersion?: string | null;
  imageVersion?: string | null;
  imageUpdate?: { version: string } | null;
  upgrade: ComputerUpgradeOutcome | { state: "idle" };
  request: ComputerUpgradeRequest;
  /**
   * From the server status when this panel has no local request (reload / another viewer).
   * A cloud runtime upgrade must not paint the Image row.
   */
  upgradeTarget?: ComputerUpgradeTarget;
  latestComputerVersion: string | null | undefined;
}) {
  const isCloud = computerKind(input.kind) === "cloud";
  const upgrade = input.upgrade;
  const owner =
    (input.request.state !== "idle" ? input.request.target : undefined) ?? input.upgradeTarget;
  const runtimeSucceeded = owner === "runtime" && upgrade.state === "succeeded";
  const imageSucceeded = owner === "image" && upgrade.state === "succeeded";
  const currentVersion =
    upgrade.state === "succeeded" && (!isCloud || runtimeSucceeded)
      ? upgrade.version
      : input.computerVersion;
  const currentImageVersion = isCloud && imageSucceeded ? upgrade.version : input.imageVersion;
  const runtimeSlot = upgradeSlotState({
    upgrade,
    request: input.request,
    slot: "runtime",
    owner,
    computer: input,
    currentVersion,
    latestComputerVersion: input.latestComputerVersion,
  });
  const imageSlot = isCloud
    ? upgradeSlotState({
        upgrade,
        request: input.request,
        slot: "image",
        owner,
        computer: input,
        currentVersion: currentImageVersion,
        latestComputerVersion: input.latestComputerVersion,
        offer: imageSucceeded ? null : (input.imageUpdate?.version ?? null),
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

/** Detail panel wiring: prefer the live status target, else the loader's stored upgrade. */
export function computerDetailUpgradeSlotsFor(
  computer: {
    kind: string;
    computerVersion?: string | null;
    imageVersion?: string | null;
    imageUpdate?: { version: string } | null;
  },
  input: {
    upgrade: ComputerUpgradeOutcome | { state: "idle" };
    request: ComputerUpgradeRequest;
    liveStatus?: ComputerUpgradeStatus;
    storedUpgrade?: ComputerUpgradeStatus | null;
    latestComputerVersion: string | null | undefined;
  },
) {
  return computerDetailUpgradeSlots({
    ...computer,
    upgrade: input.upgrade,
    request: input.request,
    upgradeTarget:
      computerUpgradeTarget(input.liveStatus) ?? computerUpgradeTarget(input.storedUpgrade),
    latestComputerVersion: input.latestComputerVersion,
  });
}
